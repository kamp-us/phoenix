/**
 * standup/register-local-scope — write each crew pane's channel MCP server into a PERSISTED config
 * scope so claude 2.1.212's channel-ref resolver actually sees it (issue #3444).
 *
 * The forcing fact: the resolver validates a `server:<name>` ref against the four persisted scopes
 * only (enterprise/user/project/local) and NEVER an inline `--mcp-config`, so the crew server must
 * live in a persisted scope. `local` scope is `~/.claude.json → projects[<resolved cwd>].mcpServers[<name>]`.
 *
 * Two hard-won CLI facts shape the design (verified against 2.1.212, dogfooded):
 *   1. A local entry is READ ONCE AT BOOT to spawn the stdio server; the running server is never
 *      re-evaluated against the file. So an entry can be safely removed after its pane has booted —
 *      the teardown (`reap` / stand-down) never kills a live session.
 *   2. ALL local `mcpServers` under a given `projects[cwd]` auto-connect for EVERY claude launched in
 *      that cwd, regardless of `--channels`. Each crew session takes a cardinality-1 role lease, so a
 *      pane that saw a SIBLING's entry at boot would spawn it and trigger a role-lease storm.
 *      Therefore each pane must see ONLY its own entry — achieved by giving each pane a DISTINCT,
 *      git-valid launch cwd (a per-run dir under `<projectRoot>/.claude/crew-run/`), so its
 *      `projects[cwd]` key is isolated. Distinct cwds make it safe to write every pane's entry in ONE
 *      atomic RMW: isolation is by cwd key, not by write timing.
 *
 * The live crew is actively using `~/.claude.json`, so every mutation goes through `proper-lockfile`
 * (the same lock the CLI coordinates on, lockfile `~/.claude.json.lock`) and writes via atomic
 * temp-file + rename, never a naive in-place write the CLI's watcher could tear-read.
 *
 * Pure transforms (`applyLocalEntries` / `reapLocalEntries`) are separated from the locked IO
 * (`withLockedClaudeConfig`) so the config-shaping logic is unit-tested with no lock and no real
 * `~/.claude.json` — the IO wrapper is exercised against an injected temp path.
 */
import {randomUUID} from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import {homedir} from "node:os";
import {dirname, join, sep} from "node:path";
import {Effect, Schema} from "effect";
import lockfile from "proper-lockfile";
import type {CrewServerConfig} from "./bind.ts";

/** One pane's persisted local-scope crew entry: its distinct launch cwd (the `projects[]` key), the server name, its config. */
export interface CrewLocalEntry {
	readonly cwd: string;
	readonly serverName: string;
	readonly serverConfig: CrewServerConfig;
}

/** A persisted-scope write could not be committed — the crew launch fails closed on it (AC3, #3444). */
export class LocalScopeWriteError extends Schema.TaggedErrorClass<LocalScopeWriteError>()(
	"@kampus/pipeline-crew-mcp/standup/LocalScopeWriteError",
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

/**
 * Set each pane's crew server into `projects[cwd].mcpServers[serverName]`, rebuilding only the touched
 * path immutably so every sibling project record and every other server entry is preserved untouched.
 * Pure over the parsed `~/.claude.json` value.
 */
export const applyLocalEntries = (
	root: unknown,
	entries: readonly CrewLocalEntry[],
): JsonObject => {
	const out = asObject(root);
	const projects = asObject(out.projects);
	for (const {cwd, serverName, serverConfig} of entries) {
		const project = asObject(projects[cwd]);
		const mcpServers = asObject(project.mcpServers);
		mcpServers[serverName] = {command: serverConfig.command, args: [...serverConfig.args]};
		project.mcpServers = mcpServers;
		projects[cwd] = project;
	}
	out.projects = projects;
	return out;
};

/** True when `key` is the prefix dir itself or a path strictly under it (path-segment aware, not a bare substring). */
const isUnderPrefix = (key: string, prefix: string): boolean =>
	key === prefix || key.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep);

/**
 * Remove the crew server from every `projects[cwd]` whose cwd is under the crew-run `prefix` — the
 * idempotent, prefix-keyed sweep of a prior (possibly crashed) run's entries. Only the crew server
 * key is deleted (fact #1 makes that safe even for a still-running crew); an emptied `mcpServers` is
 * pruned, and a project record left with nothing (a launcher-owned dir) is dropped entirely. Pure.
 */
export const reapLocalEntries = (root: unknown, prefix: string, serverName: string): JsonObject => {
	const out = asObject(root);
	const projectsRaw = asObject(out.projects);
	const projects: JsonObject = {};
	for (const [key, value] of Object.entries(projectsRaw)) {
		if (!isUnderPrefix(key, prefix)) {
			projects[key] = value;
			continue;
		}
		const project = asObject(value);
		const mcpServers = asObject(project.mcpServers);
		delete mcpServers[serverName];
		if (Object.keys(mcpServers).length > 0) project.mcpServers = mcpServers;
		else delete project.mcpServers;
		if (Object.keys(project).length > 0) projects[key] = project;
	}
	out.projects = projects;
	return out;
};

/** The default `local` scope file: `~/.claude.json`. Injected as a temp path in tests — a unit test NEVER touches the real one. */
export const claudeConfigPath = (home: string = homedir()): string => join(home, ".claude.json");

/** Write `content` to `path` atomically: a sibling temp file, then a rename — so the CLI's watcher never tear-reads a partial write. */
const atomicWrite = (path: string, content: string): void => {
	const temp = join(dirname(path), `.claude.json.crew-${randomUUID().slice(0, 8)}.tmp`);
	writeFileSync(temp, content);
	renameSync(temp, path);
};

/**
 * Run a locked read-modify-write over the persisted config file: ensure it exists, acquire the
 * `proper-lockfile` lock (retrying against the CLI's concurrent hold), read + parse, apply the pure
 * `transform`, atomic-write, and release the lock whichever way we exit. Fails closed with a
 * `LocalScopeWriteError` on any step — a lost lock, a malformed file, or a failed write is a crew
 * launch to refuse, never a silent partial registration (AC3).
 */
export const withLockedClaudeConfig = (
	configPath: string,
	transform: (root: unknown) => JsonObject,
): Effect.Effect<void, LocalScopeWriteError> => {
	const fail = (reason: string) => new LocalScopeWriteError({configPath, reason});
	return Effect.acquireUseRelease(
		Effect.gen(function* () {
			// proper-lockfile lstats/realpaths the target, so it must exist before we can lock it. The CLI
			// normally owns this file; a first-ever launcher run may precede it, so seed an empty object.
			yield* Effect.try({
				try: () => {
					if (!existsSync(configPath)) atomicWrite(configPath, "{}");
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

export interface LocalScopeOptions {
	/** The persisted-scope file to mutate. Default: `~/.claude.json`. Injected as a temp path in tests. */
	readonly configPath?: string;
}

/** Register every pane's crew server into the persisted local scope in ONE locked atomic RMW (#3444). */
export const registerCrewLocalScope = (
	entries: readonly CrewLocalEntry[],
	opts: LocalScopeOptions = {},
): Effect.Effect<void, LocalScopeWriteError> =>
	withLockedClaudeConfig(opts.configPath ?? claudeConfigPath(), (root) =>
		applyLocalEntries(root, entries),
	);

/** Sweep every crew entry under `prefix` from the persisted local scope in one locked atomic RMW. */
export const reapCrewLocalScope = (
	prefix: string,
	serverName: string,
	opts: LocalScopeOptions = {},
): Effect.Effect<void, LocalScopeWriteError> =>
	withLockedClaudeConfig(opts.configPath ?? claudeConfigPath(), (root) =>
		reapLocalEntries(root, prefix, serverName),
	);

/** The launcher-owned dir under the repo that holds each run's per-pane launch cwds (gitignored; per-machine). */
export const CREW_RUN_DIR = join(".claude", "crew-run");

/** `<projectRoot>/.claude/crew-run` — the parent of every run's per-pane cwd dirs. */
export const crewRunRoot = (projectRoot: string): string => join(projectRoot, CREW_RUN_DIR);

/**
 * Ensure the crew-run root exists and return its RESOLVED path — the reaper's prefix. Realpath so it
 * matches how claude keys `projects[]` (by resolved cwd), regardless of symlinks in `projectRoot`.
 */
export const ensureCrewRunPrefix = (projectRoot: string): string => {
	const root = crewRunRoot(projectRoot);
	mkdirSync(root, {recursive: true});
	return realpathSync(root);
};

const sanitizePaneLabel = (label: string): string => label.replace(/[^A-Za-z0-9._-]/g, "_");

/**
 * Ensure a distinct, git-valid launch cwd for one pane and return its RESOLVED path (the `projects[]`
 * key). Distinct per (runId, paneLabel) so each pane's local scope is isolated (fact #2); inside the
 * repo so the pane's `git`/`gh` still work (never a synthetic empty dir outside the repo).
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

/** Ensure the crew-run prefix, then sweep this project's prior-run crew entries — the production start-of-stand-up reaper. */
export const reapCrewLocalScopeFor = (
	projectRoot: string,
	serverName: string,
	opts: LocalScopeOptions = {},
): Effect.Effect<void, LocalScopeWriteError> =>
	Effect.gen(function* () {
		const prefix = yield* Effect.try({
			try: () => ensureCrewRunPrefix(projectRoot),
			catch: (cause) =>
				new LocalScopeWriteError({
					configPath: opts.configPath ?? claudeConfigPath(),
					reason: `cannot resolve crew-run prefix under ${projectRoot}: ${String(cause)}`,
				}),
		});
		yield* reapCrewLocalScope(prefix, serverName, opts);
	});
