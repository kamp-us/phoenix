/**
 * standup/register-project-scope — make each crew pane's channel MCP server visible to claude's
 * channel-ref resolver by emitting a per-pane PROJECT-scope `.mcp.json`, and pre-seed the two boot
 * gates so the panes come up non-interactively (issue #3444).
 *
 * The forcing fact (verified against the 2.1.214 bundle): a `server:<name>` channel ref resolves only
 * against the four PERSISTED config scopes (enterprise/user/project/local), never an inline
 * `--mcp-config`. The first fix wrote LOCAL scope (`~/.claude.json → projects[<cwd>].mcpServers`) —
 * a proven dead end: claude keys `projects[]` by the GIT-ROOT walk-up of cwd, not literal cwd, so all
 * per-pane crew-run subdirs collapse to ONE git-root key and no per-pane isolation is possible there.
 *
 * PROJECT scope resolves by a DIFFERENT mechanism: the collector walks from cwd UP to the FILESYSTEM
 * root, merging every `.mcp.json` it finds. Sibling pane dirs are never on each other's ancestor chain,
 * so a per-pane leaf `.mcp.json` (one carrying ONLY that pane's own crew server) gives structural
 * per-pane isolation — each pane sees only its own server, never a sibling's (which would storm the
 * cardinality-1 role lease). The hard constraint this rests on: NO `.mcp.json` may sit at any SHARED
 * ANCESTOR of the pane dirs (repo root, `.claude/`, `.claude/crew-run/`, `.claude/crew-run/<runId>/`),
 * because one there merges into EVERY pane and breaks isolation — `assertNoSharedAncestorMcpJson`
 * fails the launch closed if one is found.
 *
 * Emitting the `.mcp.json` makes the server VISIBLE; two boot gates still make it USABLE non-interactively:
 *   1. Folder trust — `projects[<git-root>].hasTrustDialogAccepted === true` in `~/.claude.json`. When
 *      true, the approval resolver (`DXr`) reads the server's approval from MERGED SETTINGS only.
 *   2. Server approval — `enabledMcpjsonServers` must include the crew server name in a merged settings
 *      source. The trusted-folder resolver reads `Vn()` (merged userSettings/projectSettings/localSettings);
 *      it does NOT read `projects[<git-root>].enabledMcpjsonServers` (that is a legacy field migrated to
 *      settings on startup, never read live). We seed `userSettings` (`~/.claude/settings.json`) — the
 *      one merged source OUTSIDE the repo, so no `.claude/**` file is dirtied. Targeted (the single crew
 *      server name), never the broad `enableAllProjectMcpServers`, and `disabledMcpjsonServers` is never touched.
 *
 * `~/.claude.json` is live-shared with the running crew, so its mutation goes through `proper-lockfile`
 * (the lock the CLI coordinates on) + atomic temp-file+rename; `~/.claude/settings.json` uses the same
 * locked-atomic RMW. Pure transforms are separated from the locked IO so the config-shaping logic is
 * unit-tested with no lock and no real config file — the IO wrappers run against injected temp paths.
 */
import {randomUUID} from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {homedir} from "node:os";
import {dirname, join, normalize, parse as parsePath} from "node:path";
import {Effect, Schema} from "effect";
import lockfile from "proper-lockfile";
import type {CrewServerConfig} from "./bind.ts";

/** One pane's project-scope crew entry: its distinct launch cwd (where the leaf `.mcp.json` lands), the server name, its config. */
export interface CrewMcpEntry {
	readonly cwd: string;
	readonly serverName: string;
	readonly serverConfig: CrewServerConfig;
}

/** A project-scope write or a boot-gate seed could not be committed — the crew launch fails closed on it (AC3, #3444). */
export class ProjectScopeWriteError extends Schema.TaggedErrorClass<ProjectScopeWriteError>()(
	"@kampus/pipeline-crew-mcp/standup/ProjectScopeWriteError",
	{
		configPath: Schema.String,
		reason: Schema.String,
	},
) {}

type JsonObject = Record<string, unknown>;

/** Shallow-copy a value into a plain object, or a fresh `{}` for a non-object — so a malformed key never shares a ref. */
const asObject = (value: unknown): JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? {...(value as JsonObject)}
		: {};

/** A fresh string array from a value, or `[]` for a non-array — so a malformed `enabledMcpjsonServers` never shares a ref. */
const asStringArray = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

// ── per-pane `.mcp.json` (project scope) ────────────────────────────────────────────────────────

/** The project-scope config filename claude's cwd→filesystem-root collector merges. */
export const MCP_JSON_FILENAME = ".mcp.json";

/** The leaf `.mcp.json` path for a pane's launch cwd. */
export const mcpJsonPath = (cwd: string): string => join(cwd, MCP_JSON_FILENAME);

/**
 * One pane's `.mcp.json` content: exactly ONE server (that pane's own crew server) under `mcpServers`.
 * The value is the same `serverConfig` bind.ts builds — the shape a persisted-scope `mcpServers[name]`
 * entry carries, so the channel resolver sees the server. Pure.
 */
export const buildMcpJsonContent = (entry: CrewMcpEntry): JsonObject => ({
	mcpServers: {
		[entry.serverName]: {command: entry.serverConfig.command, args: [...entry.serverConfig.args]},
	},
});

/** The launcher-owned dir under the repo that holds each run's per-pane launch cwds (gitignored; per-machine). */
export const CREW_RUN_DIR = join(".claude", "crew-run");

/** `<projectRoot>/.claude/crew-run` — the parent of every run's per-pane cwd dirs. */
export const crewRunRoot = (projectRoot: string): string => join(projectRoot, CREW_RUN_DIR);

/**
 * Ensure the crew-run root exists and return its RESOLVED path. Realpath so it matches how a pane's
 * launch cwd resolves regardless of symlinks in `projectRoot`.
 */
export const ensureCrewRunPrefix = (projectRoot: string): string => {
	const root = crewRunRoot(projectRoot);
	mkdirSync(root, {recursive: true});
	return realpathSync(root);
};

const sanitizePaneLabel = (label: string): string => label.replace(/[^A-Za-z0-9._-]/g, "_");

/**
 * Ensure a distinct, git-valid launch cwd for one pane and return its RESOLVED path (where its leaf
 * `.mcp.json` lands). Distinct per (runId, paneLabel) so each pane's project-scope leaf is on its own
 * ancestor chain; inside the repo so the pane's `git`/`gh` still work (never a synthetic dir outside it).
 */
export const ensurePaneCwd = (projectRoot: string, runId: string, paneLabel: string): string => {
	const dir = join(
		crewRunRoot(projectRoot),
		sanitizePaneLabel(runId),
		sanitizePaneLabel(paneLabel),
	);
	mkdirSync(dir, {recursive: true});
	return realpathSync(dir);
};

/**
 * The dirs that are SHARED ANCESTORS of every pane's launch cwd, from the repo root down through the
 * run dir: repo root, `.claude/`, `.claude/crew-run/`, `.claude/crew-run/<runId>/`. A `.mcp.json` at
 * any of these merges into EVERY pane (the collector walks cwd→filesystem-root), so each must be free
 * of one for per-pane isolation to hold.
 */
export const sharedAncestorDirs = (projectRoot: string, runId: string): readonly string[] => [
	projectRoot,
	join(projectRoot, ".claude"),
	crewRunRoot(projectRoot),
	join(crewRunRoot(projectRoot), sanitizePaneLabel(runId)),
];

/**
 * Fail the launch closed if a `.mcp.json` sits at ANY shared ancestor of the pane dirs — one there
 * would merge into every pane and break the per-pane isolation + role assignment the whole fix rests
 * on (#3444). `fileExists` is injected so the guard is unit-testable without planting real files.
 */
export const assertNoSharedAncestorMcpJson = (
	projectRoot: string,
	runId: string,
	fileExists: (path: string) => boolean = existsSync,
): Effect.Effect<void, ProjectScopeWriteError> =>
	Effect.gen(function* () {
		for (const dir of sharedAncestorDirs(projectRoot, runId)) {
			const path = mcpJsonPath(dir);
			if (fileExists(path)) {
				return yield* Effect.fail(
					new ProjectScopeWriteError({
						configPath: path,
						reason: `a .mcp.json at shared ancestor "${dir}" would merge into every crew pane and break per-pane channel isolation — remove it before standing the crew up`,
					}),
				);
			}
		}
	});

/** Write `content` to `path` atomically: a sibling temp file, then a rename — so no reader tear-reads a partial write. */
const atomicWrite = (path: string, content: string): void => {
	const temp = join(dirname(path), `.crew-${randomUUID().slice(0, 8)}.tmp`);
	writeFileSync(temp, content);
	renameSync(temp, path);
};

/**
 * Emit each pane's leaf `.mcp.json` (one server per file) into its distinct launch cwd, AFTER the
 * shared-ancestor guard passes. Fails closed with a `ProjectScopeWriteError` on the guard or any write.
 */
export const writeCrewMcpJson = (
	projectRoot: string,
	runId: string,
	entries: readonly CrewMcpEntry[],
	fileExists: (path: string) => boolean = existsSync,
): Effect.Effect<void, ProjectScopeWriteError> =>
	Effect.gen(function* () {
		yield* assertNoSharedAncestorMcpJson(projectRoot, runId, fileExists);
		for (const entry of entries) {
			const path = mcpJsonPath(entry.cwd);
			yield* Effect.try({
				try: () => {
					mkdirSync(entry.cwd, {recursive: true});
					atomicWrite(path, JSON.stringify(buildMcpJsonContent(entry), null, "\t"));
				},
				catch: (cause) =>
					new ProjectScopeWriteError({
						configPath: path,
						reason: `cannot write pane .mcp.json: ${String(cause)}`,
					}),
			});
		}
	});

// ── locked-atomic JSON RMW (shared by ~/.claude.json + ~/.claude/settings.json) ──────────────────

/** The `local`-scope / folder-trust file: `~/.claude.json`. Injected as a temp path in tests — a unit test NEVER touches the real one. */
export const claudeConfigPath = (home: string = homedir()): string => join(home, ".claude.json");

/** The `userSettings` merged-settings source: `~/.claude/settings.json`. Injected as a temp path in tests. */
export const userSettingsPath = (home: string = homedir()): string =>
	join(home, ".claude", "settings.json");

/**
 * Run a locked read-modify-write over a JSON config file: ensure it exists, acquire the
 * `proper-lockfile` lock (retrying against the CLI's concurrent hold), read + parse, apply the pure
 * `transform`, atomic-write, release the lock on every exit. Fails closed with a `ProjectScopeWriteError`
 * on any step — a lost lock, a malformed file, or a failed write is a crew launch to refuse, never a
 * silent partial seed (AC3). Shared by the `~/.claude.json` trust seed and the `~/.claude/settings.json`
 * approval seed — one locked writer, not two hand-rolled ones.
 */
export const withLockedJsonFile = (
	configPath: string,
	transform: (root: unknown) => JsonObject,
): Effect.Effect<void, ProjectScopeWriteError> => {
	const fail = (reason: string) => new ProjectScopeWriteError({configPath, reason});
	return Effect.acquireUseRelease(
		Effect.gen(function* () {
			// proper-lockfile lstats/realpaths the target, so it must exist before we can lock it. The CLI
			// normally owns these files; a first-ever launcher run may precede it, so seed an empty object.
			yield* Effect.try({
				try: () => {
					if (!existsSync(configPath)) {
						mkdirSync(dirname(configPath), {recursive: true});
						atomicWrite(configPath, "{}");
					}
				},
				catch: (cause) => fail(`cannot ensure ${configPath} exists: ${String(cause)}`),
			});
			return yield* Effect.tryPromise({
				try: () =>
					lockfile.lock(configPath, {
						stale: 15_000,
						retries: {retries: 15, factor: 1.5, minTimeout: 50, maxTimeout: 1_000},
					}),
				catch: (cause) => fail(`cannot acquire lock ${configPath}.lock: ${String(cause)}`),
			});
		}),
		() =>
			Effect.gen(function* () {
				const text = yield* Effect.try({
					try: () => readFileSync(configPath, "utf8"),
					catch: (cause) => fail(`cannot read ${configPath}: ${String(cause)}`),
				});
				const parsed = yield* Effect.try({
					try: () => JSON.parse(text) as unknown,
					catch: (cause) => fail(`malformed JSON in ${configPath}: ${String(cause)}`),
				});
				yield* Effect.try({
					try: () => atomicWrite(configPath, JSON.stringify(transform(parsed))),
					catch: (cause) => fail(`cannot write ${configPath}: ${String(cause)}`),
				});
			}),
		// The finalizer must not fail (release runs on every exit), so a rejected release is swallowed —
		// object-notation `tryPromise` keeps the rejection in a typed error channel, then `ignore` drops it
		// to `never`. A bare `Effect.promise` here would turn a rejection into an uncatchable defect (#2736).
		(release) =>
			Effect.tryPromise({
				try: () => release(),
				catch: (cause) => fail(`cannot release lock ${configPath}.lock: ${String(cause)}`),
			}).pipe(Effect.ignore),
	);
};

// ── folder trust (~/.claude.json) ────────────────────────────────────────────────────────────────

/**
 * The `projects[]` key claude trusts a folder under: the git-root walk-up of `startDir`, RESOLVED
 * (claude's `Nae(Vd(cwd) ?? resolve(cwd))` keys by the realpathed cwd's git root, since a pane launches
 * in a realpathed cwd). A crew pane's cwd sits inside the repo, so its trust key is the repo's git root —
 * one shared key for all panes. Realpath so a symlinked/`/var`→`/private/var` path matches claude's key.
 */
export const resolveGitRoot = (startDir: string): string => {
	// realpathSync throws only for a nonexistent path, so gate on existsSync (a native try/catch is
	// banned in an Effect-importing file, and this pure pre-Effect helper has no failure channel).
	const resolved = (dir: string): string => (existsSync(dir) ? realpathSync(dir) : normalize(dir));
	let dir = normalize(startDir);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return resolved(dir);
		const parent = dirname(dir);
		if (parent === dir || parent === parsePath(dir).root) {
			return existsSync(join(parent, ".git")) ? resolved(parent) : resolved(startDir);
		}
		dir = parent;
	}
};

/** Set `projects[gitRoot].hasTrustDialogAccepted = true`, rebuilding only the touched path so every other project record survives. Pure. */
export const applyTrust = (root: unknown, gitRoot: string): JsonObject => {
	const out = asObject(root);
	const projects = asObject(out.projects);
	const project = asObject(projects[gitRoot]);
	project.hasTrustDialogAccepted = true;
	projects[gitRoot] = project;
	out.projects = projects;
	return out;
};

/** Ensure the crew's git-root folder is trusted so the panes boot without the trust dialog. Idempotent; the phoenix root is likely already trusted. */
export const ensureFolderTrusted = (
	gitRoot: string,
	opts: {readonly configPath?: string | undefined} = {},
): Effect.Effect<void, ProjectScopeWriteError> =>
	withLockedJsonFile(opts.configPath ?? claudeConfigPath(), (root) => applyTrust(root, gitRoot));

// ── server approval (~/.claude/settings.json = userSettings) ─────────────────────────────────────

/** Add `serverName` to `enabledMcpjsonServers` if missing, preserving every other settings key + approval. Idempotent, no-clobber. Pure. */
export const applyEnableApproval = (root: unknown, serverName: string): JsonObject => {
	const out = asObject(root);
	const enabled = asStringArray(out.enabledMcpjsonServers);
	if (!enabled.includes(serverName)) enabled.push(serverName);
	out.enabledMcpjsonServers = enabled;
	return out;
};

/**
 * Remove `serverName` from `enabledMcpjsonServers`, leaving every OTHER approval + settings key
 * untouched; drop the key entirely when it empties. `disabledMcpjsonServers` is never touched. Pure.
 */
export const applyDisableApproval = (root: unknown, serverName: string): JsonObject => {
	const out = asObject(root);
	if (!("enabledMcpjsonServers" in out)) return out;
	const enabled = asStringArray(out.enabledMcpjsonServers).filter((s) => s !== serverName);
	if (enabled.length > 0) out.enabledMcpjsonServers = enabled;
	else delete out.enabledMcpjsonServers;
	return out;
};

/** Approve the crew server for the trusted folder by adding it to `userSettings.enabledMcpjsonServers`. Idempotent. */
export const enableCrewServerApproval = (
	serverName: string,
	opts: {readonly settingsPath?: string | undefined} = {},
): Effect.Effect<void, ProjectScopeWriteError> =>
	withLockedJsonFile(opts.settingsPath ?? userSettingsPath(), (root) =>
		applyEnableApproval(root, serverName),
	);

/** Surgically revoke the crew server's approval — remove it from `userSettings.enabledMcpjsonServers`, leaving the operator's other approvals. Idempotent. */
export const disableCrewServerApproval = (
	serverName: string,
	opts: {readonly settingsPath?: string | undefined} = {},
): Effect.Effect<void, ProjectScopeWriteError> =>
	withLockedJsonFile(opts.settingsPath ?? userSettingsPath(), (root) =>
		applyDisableApproval(root, serverName),
	);

// ── compose: register + reap ─────────────────────────────────────────────────────────────────────

export interface RegisterCrewProjectScopeInput {
	readonly projectRoot: string;
	readonly runId: string;
	readonly serverName: string;
	readonly entries: readonly CrewMcpEntry[];
	/** Override `~/.claude.json` (the trust seed). Injected as a temp path in tests. */
	readonly configPath?: string;
	/** Override `~/.claude/settings.json` (the approval seed). Injected as a temp path in tests. */
	readonly settingsPath?: string;
}

/**
 * Register the whole crew's project-scope visibility + boot gates: guard the shared ancestors, emit
 * every pane's leaf `.mcp.json`, ensure the git-root folder is trusted (`~/.claude.json`), and approve
 * the crew server (`~/.claude/settings.json`). Fails closed at the first failing step (#3444).
 */
export const registerCrewProjectScope = (
	input: RegisterCrewProjectScopeInput,
): Effect.Effect<void, ProjectScopeWriteError> =>
	Effect.gen(function* () {
		yield* writeCrewMcpJson(input.projectRoot, input.runId, input.entries);
		yield* ensureFolderTrusted(resolveGitRoot(input.projectRoot), {configPath: input.configPath});
		yield* enableCrewServerApproval(input.serverName, {settingsPath: input.settingsPath});
	});

/**
 * Tear this project's crew registration down (symmetric teardown + start-of-stand-up reaper): remove
 * the launcher-owned crew-run dir tree (every pane's leaf `.mcp.json` with it) and surgically revoke
 * the crew server's approval. Removal is safe even while a crew is live — a booted stdio server is
 * never re-read against its `.mcp.json`. Idempotent: a second reap is a clean no-op.
 */
export const reapCrewProjectScopeFor = (
	projectRoot: string,
	serverName: string,
	opts: {readonly settingsPath?: string | undefined} = {},
): Effect.Effect<void, ProjectScopeWriteError> =>
	Effect.gen(function* () {
		const runRoot = crewRunRoot(projectRoot);
		yield* Effect.try({
			try: () => rmSync(runRoot, {recursive: true, force: true}),
			catch: (cause) =>
				new ProjectScopeWriteError({
					configPath: runRoot,
					reason: `cannot remove crew-run dir ${runRoot}: ${String(cause)}`,
				}),
		});
		yield* disableCrewServerApproval(serverName, {settingsPath: opts.settingsPath});
	});
