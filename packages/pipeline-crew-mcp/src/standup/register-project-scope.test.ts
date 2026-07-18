/**
 * The project-scope registrar (#3444): the pure config transforms, the per-pane `.mcp.json` emission +
 * shared-ancestor isolation guard, and the two locked-atomic boot-gate seeds.
 *
 * The pure transforms (`buildMcpJsonContent` / `applyTrust` / `applyEnable|DisableApproval`) are tested
 * with no IO. Every IO path — the `.mcp.json` writes, the `~/.claude.json` trust seed, and the
 * `~/.claude/settings.json` approval seed — runs against INJECTED temp paths + temp project roots: no
 * test EVER touches the real `~/.claude.json` or the real `~/.claude/settings.json`.
 */
import {randomUUID} from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import type {CrewServerConfig} from "./bind.ts";
import {
	applyDisableApproval,
	applyEnableApproval,
	applyTrust,
	assertNoSharedAncestorMcpJson,
	buildMcpJsonContent,
	type CrewMcpEntry,
	crewRunRoot,
	disableCrewServerApproval,
	enableCrewServerApproval,
	ensureCrewRunPrefix,
	ensureFolderTrusted,
	ensurePaneCwd,
	mcpJsonPath,
	ProjectScopeWriteError,
	reapCrewProjectScopeFor,
	registerCrewProjectScope,
	resolveGitRoot,
	sharedAncestorDirs,
	writeCrewMcpJson,
} from "./register-project-scope.ts";

const SERVER = "@kampus/pipeline-crew-mcp";
const cfg = (role: string): CrewServerConfig => ({
	command: "/usr/bin/node",
	args: ["/abs/bin.ts", "session", "--role", role],
});
const entry = (cwd: string, role: string): CrewMcpEntry => ({
	cwd,
	serverName: SERVER,
	serverConfig: cfg(role),
});

const tempJson = (initial: unknown = {}): string => {
	const dir = mkdtempSync(join(tmpdir(), "crew-projscope-"));
	const path = join(dir, "file.json");
	writeFileSync(path, JSON.stringify(initial));
	return path;
};

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8"));

describe("register-project-scope — pure transforms", () => {
	it("buildMcpJsonContent emits exactly ONE server (the pane's own) under mcpServers", () => {
		const content = buildMcpJsonContent(entry("/cwd/a", "cos"));
		assert.deepStrictEqual(content, {mcpServers: {[SERVER]: cfg("cos")}});
		// distinct calls never share the args array ref — a later mutation can't bleed across panes.
		const other = buildMcpJsonContent(entry("/cwd/b", "em"));
		const a = (content.mcpServers as Record<string, CrewServerConfig>)[SERVER];
		const b = (other.mcpServers as Record<string, CrewServerConfig>)[SERVER];
		assert.notStrictEqual(a?.args, b?.args);
	});

	it("applyTrust sets projects[gitRoot].hasTrustDialogAccepted=true, preserving other projects + keys", () => {
		const root = {
			projects: {"/other": {hasTrustDialogAccepted: true, history: [1]}},
			topLevel: "keep",
		};
		const out = applyTrust(root, "/repo");
		const projects = out.projects as Record<string, Record<string, unknown>>;
		assert.strictEqual(out.topLevel, "keep");
		assert.strictEqual(projects["/repo"]?.hasTrustDialogAccepted, true);
		// the pre-existing project + its history survive untouched.
		assert.deepStrictEqual(projects["/other"], {hasTrustDialogAccepted: true, history: [1]});
	});

	it("applyTrust is idempotent + merges into an existing project record without clobbering it", () => {
		const root = {projects: {"/repo": {allowedTools: ["x"], hasTrustDialogAccepted: true}}};
		const out = applyTrust(root, "/repo");
		assert.deepStrictEqual(out.projects, {
			"/repo": {allowedTools: ["x"], hasTrustDialogAccepted: true},
		});
	});

	it("applyEnableApproval adds the server if missing, idempotent, preserving other keys + approvals", () => {
		const root = {enabledMcpjsonServers: ["some-other"], theme: "dark"};
		const once = applyEnableApproval(root, SERVER);
		assert.deepStrictEqual(once.enabledMcpjsonServers, ["some-other", SERVER]);
		assert.strictEqual(once.theme, "dark");
		// a second enable is a no-op — the server is not duplicated.
		const twice = applyEnableApproval(once, SERVER);
		assert.deepStrictEqual(twice.enabledMcpjsonServers, ["some-other", SERVER]);
	});

	it("applyEnableApproval seeds the array on a settings file that has none", () => {
		const out = applyEnableApproval({theme: "dark"}, SERVER);
		assert.deepStrictEqual(out.enabledMcpjsonServers, [SERVER]);
		assert.strictEqual(out.theme, "dark");
	});

	it("applyDisableApproval removes ONLY our server, leaving the operator's other approvals + never touching disabled", () => {
		const root = {
			enabledMcpjsonServers: ["keep-me", SERVER, "keep-me-too"],
			disabledMcpjsonServers: ["nope"],
			theme: "dark",
		};
		const out = applyDisableApproval(root, SERVER);
		assert.deepStrictEqual(out.enabledMcpjsonServers, ["keep-me", "keep-me-too"]);
		// disabledMcpjsonServers is never read or written by the revoke.
		assert.deepStrictEqual(out.disabledMcpjsonServers, ["nope"]);
		assert.strictEqual(out.theme, "dark");
	});

	it("applyDisableApproval drops the key entirely when our server was the only approval; idempotent + no-key safe", () => {
		const emptied = applyDisableApproval({enabledMcpjsonServers: [SERVER], theme: "dark"}, SERVER);
		assert.notProperty(emptied, "enabledMcpjsonServers");
		assert.strictEqual(emptied.theme, "dark");
		// a second revoke over a file with no such key is a clean no-op.
		assert.deepStrictEqual(applyDisableApproval({theme: "dark"}, SERVER), {theme: "dark"});
	});
});

describe("register-project-scope — per-pane .mcp.json emission + shared-ancestor guard", () => {
	it.effect("writeCrewMcpJson emits one role-specific leaf .mcp.json per pane cwd", () =>
		Effect.gen(function* () {
			const projectRoot = mkdtempSync(join(tmpdir(), "crew-proj-"));
			try {
				const runId = "run0";
				const cwdA = ensurePaneCwd(projectRoot, runId, "chief-of-staff");
				const cwdB = ensurePaneCwd(projectRoot, runId, "engineering-manager");
				yield* writeCrewMcpJson(projectRoot, runId, [entry(cwdA, "cos"), entry(cwdB, "em")]);

				// each pane's leaf carries ONLY its own role's server — the fact the per-pane isolation rests on.
				assert.deepStrictEqual(readJson(mcpJsonPath(cwdA)), {mcpServers: {[SERVER]: cfg("cos")}});
				assert.deepStrictEqual(readJson(mcpJsonPath(cwdB)), {mcpServers: {[SERVER]: cfg("em")}});
			} finally {
				rmSync(projectRoot, {recursive: true, force: true});
			}
		}),
	);

	it.effect(
		"writeCrewMcpJson fails closed when a .mcp.json sits at a shared ancestor (isolation guard)",
		() =>
			Effect.gen(function* () {
				const projectRoot = mkdtempSync(join(tmpdir(), "crew-proj-"));
				try {
					const runId = "run0";
					const cwd = ensurePaneCwd(projectRoot, runId, "chief-of-staff");
					// plant a .mcp.json at the crew-run root — a SHARED ancestor of every pane dir.
					writeFileSync(mcpJsonPath(crewRunRoot(projectRoot)), JSON.stringify({mcpServers: {}}));

					const err = yield* Effect.flip(writeCrewMcpJson(projectRoot, runId, [entry(cwd, "cos")]));
					assert.instanceOf(err, ProjectScopeWriteError);
					assert.include(err.reason, "shared ancestor");
					// the guard runs BEFORE any pane write — no leaf .mcp.json was emitted.
					assert.isFalse(existsSync(mcpJsonPath(cwd)));
				} finally {
					rmSync(projectRoot, {recursive: true, force: true});
				}
			}),
	);

	it.effect(
		"assertNoSharedAncestorMcpJson refuses for EACH shared ancestor, passes when all clean",
		() =>
			Effect.gen(function* () {
				const projectRoot = "/repo";
				const runId = "run0";
				const ancestors = sharedAncestorDirs(projectRoot, runId);
				// four shared ancestors: repo root, .claude, crew-run, crew-run/<runId>.
				assert.strictEqual(ancestors.length, 4);

				for (const bad of ancestors) {
					const fileExists = (p: string) => p === mcpJsonPath(bad);
					const err = yield* Effect.flip(
						assertNoSharedAncestorMcpJson(projectRoot, runId, fileExists),
					);
					assert.instanceOf(err, ProjectScopeWriteError);
					assert.strictEqual(err.configPath, mcpJsonPath(bad));
				}
				// none present ⇒ the guard passes.
				yield* assertNoSharedAncestorMcpJson(projectRoot, runId, () => false);
			}),
	);

	it("resolveGitRoot walks up to the dir containing .git", () => {
		const root = mkdtempSync(join(tmpdir(), "crew-gitroot-"));
		try {
			mkdirSync(join(root, ".git"));
			const nested = join(root, ".claude", "crew-run", "run0", "cos");
			mkdirSync(nested, {recursive: true});
			assert.strictEqual(resolveGitRoot(nested), realpathSync(root));
		} finally {
			rmSync(root, {recursive: true, force: true});
		}
	});
});

describe("register-project-scope — boot-gate seeds (injected temp paths, never real ~/.claude*)", () => {
	it.live(
		"ensureFolderTrusted seeds hasTrustDialogAccepted, preserving the rest of ~/.claude.json",
		() =>
			Effect.gen(function* () {
				const path = tempJson({projects: {"/other": {history: [1]}}, oauthAccount: "keep"});
				yield* ensureFolderTrusted("/repo", {configPath: path});

				const json = readJson(path);
				assert.strictEqual(json.oauthAccount, "keep");
				const projects = json.projects as Record<string, Record<string, unknown>>;
				assert.strictEqual(projects["/repo"]?.hasTrustDialogAccepted, true);
				// a pre-existing project record survives untouched (idempotent, no-clobber).
				assert.deepStrictEqual(projects["/other"], {history: [1]});
				rmSync(path, {recursive: true, force: true});
			}),
	);

	it.live(
		"enableCrewServerApproval adds the server to userSettings.enabledMcpjsonServers, no-clobber",
		() =>
			Effect.gen(function* () {
				const path = tempJson({
					enabledMcpjsonServers: ["pre-approved"],
					permissions: {allow: ["x"]},
				});
				yield* enableCrewServerApproval(SERVER, {settingsPath: path});

				const json = readJson(path);
				assert.deepStrictEqual(json.enabledMcpjsonServers, ["pre-approved", SERVER]);
				// the operator's other settings survive.
				assert.deepStrictEqual(json.permissions, {allow: ["x"]});

				// idempotent — a second enable does not duplicate.
				yield* enableCrewServerApproval(SERVER, {settingsPath: path});
				assert.deepStrictEqual(readJson(path).enabledMcpjsonServers, ["pre-approved", SERVER]);
				rmSync(path, {recursive: true, force: true});
			}),
	);

	it.live("disableCrewServerApproval surgically removes ONLY our server; idempotent", () =>
		Effect.gen(function* () {
			const path = tempJson({
				enabledMcpjsonServers: ["keep", SERVER],
				disabledMcpjsonServers: ["nope"],
			});
			yield* disableCrewServerApproval(SERVER, {settingsPath: path});

			const json = readJson(path);
			assert.deepStrictEqual(json.enabledMcpjsonServers, ["keep"]);
			// disabled list is never touched.
			assert.deepStrictEqual(json.disabledMcpjsonServers, ["nope"]);

			// a second revoke is a clean no-op.
			yield* disableCrewServerApproval(SERVER, {settingsPath: path});
			assert.deepStrictEqual(readJson(path).enabledMcpjsonServers, ["keep"]);
			rmSync(path, {recursive: true, force: true});
		}),
	);

	it.live("seeds a missing config file rather than failing (userSettings dir + file created)", () =>
		Effect.gen(function* () {
			const dir = mkdtempSync(join(tmpdir(), "crew-projscope-"));
			const path = join(dir, "nested", "settings.json"); // neither the dir nor the file exist yet
			yield* enableCrewServerApproval(SERVER, {settingsPath: path});
			assert.isTrue(existsSync(path));
			assert.deepStrictEqual(readJson(path).enabledMcpjsonServers, [SERVER]);
			rmSync(dir, {recursive: true, force: true});
		}),
	);

	it.live("fails closed with ProjectScopeWriteError on malformed JSON in the config file", () =>
		Effect.gen(function* () {
			const dir = mkdtempSync(join(tmpdir(), "crew-projscope-"));
			const path = join(dir, "settings.json");
			writeFileSync(path, "{ not json ");
			const err = yield* Effect.flip(enableCrewServerApproval(SERVER, {settingsPath: path}));
			assert.instanceOf(err, ProjectScopeWriteError);
			assert.strictEqual(err.configPath, path);
			assert.include(err.reason, "malformed JSON");
			rmSync(dir, {recursive: true, force: true});
		}),
	);

	it.live(
		"the lock serializes concurrent approval writers — every server lands (no lost update)",
		() =>
			Effect.gen(function* () {
				const path = tempJson({enabledMcpjsonServers: []});
				// 6 concurrent enables of distinct server names; proper-lockfile forces them to serialize,
				// so the atomic RMW never loses an update — all 6 survive in the final file.
				const writes = Array.from({length: 6}, (_, i) =>
					enableCrewServerApproval(`server-${i}`, {settingsPath: path}),
				);
				yield* Effect.all(writes, {concurrency: "unbounded"});

				const enabled = readJson(path).enabledMcpjsonServers as string[];
				assert.strictEqual(new Set(enabled).size, 6);
				for (let i = 0; i < 6; i++) assert.include(enabled, `server-${i}`);
				rmSync(path, {recursive: true, force: true});
			}),
	);
});

describe("register-project-scope — register + reap round-trip (injected temp paths)", () => {
	it.live(
		"registerCrewProjectScope emits leaves + seeds trust + approval; reap tears them back out",
		() =>
			Effect.gen(function* () {
				const projectRoot = mkdtempSync(join(tmpdir(), "crew-proj-"));
				mkdirSync(join(projectRoot, ".git")); // so resolveGitRoot keys trust under projectRoot
				const configPath = tempJson({});
				const settingsPath = tempJson({});
				try {
					const runId = "run0";
					const cwdA = ensurePaneCwd(projectRoot, runId, "chief-of-staff");
					const cwdB = ensurePaneCwd(projectRoot, runId, "engineering-manager");
					yield* registerCrewProjectScope({
						projectRoot,
						runId,
						serverName: SERVER,
						entries: [entry(cwdA, "cos"), entry(cwdB, "em")],
						configPath,
						settingsPath,
					});

					// every pane got its own leaf; trust + approval were seeded.
					assert.deepStrictEqual(readJson(mcpJsonPath(cwdA)), {mcpServers: {[SERVER]: cfg("cos")}});
					assert.deepStrictEqual(readJson(mcpJsonPath(cwdB)), {mcpServers: {[SERVER]: cfg("em")}});
					const gitRoot = realpathSync(projectRoot);
					const projects = readJson(configPath).projects as Record<string, Record<string, unknown>>;
					assert.strictEqual(projects[gitRoot]?.hasTrustDialogAccepted, true);
					assert.deepStrictEqual(readJson(settingsPath).enabledMcpjsonServers, [SERVER]);

					// reap removes the crew-run dirs (the leaves with them) + revokes the approval.
					yield* reapCrewProjectScopeFor(projectRoot, SERVER, {settingsPath});
					assert.isFalse(existsSync(crewRunRoot(projectRoot)), "crew-run dir tree removed");
					assert.notProperty(readJson(settingsPath), "enabledMcpjsonServers");
					// trust is intentionally left in place (harmless) — reap never touches ~/.claude.json.
					assert.strictEqual(projects[gitRoot]?.hasTrustDialogAccepted, true);

					// idempotent — a second reap over an already-torn-down project is a clean no-op.
					yield* reapCrewProjectScopeFor(projectRoot, SERVER, {settingsPath});
				} finally {
					rmSync(projectRoot, {recursive: true, force: true});
					rmSync(configPath, {recursive: true, force: true});
					rmSync(settingsPath, {recursive: true, force: true});
				}
			}),
	);
});

describe("register-project-scope — per-pane cwd isolation", () => {
	it("ensurePaneCwd mints a distinct, existing, resolved dir per (runId, pane); same inputs are stable", () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "crew-proj-"));
		try {
			const runId = randomUUID().slice(0, 8);
			const a = ensurePaneCwd(projectRoot, runId, "chief-of-staff");
			const b = ensurePaneCwd(projectRoot, runId, "engineering-manager");
			const aAgain = ensurePaneCwd(projectRoot, runId, "chief-of-staff");

			assert.notStrictEqual(a, b, "distinct panes get distinct cwds (isolated ancestor chains)");
			assert.strictEqual(a, aAgain, "the same pane resolves to the same cwd (idempotent)");
			assert.isTrue(existsSync(a) && existsSync(b), "both cwds exist on disk (git-valid dirs)");
			// realpath'd + under the crew-run prefix, so its leaf .mcp.json is on no sibling's ancestor chain.
			const prefix = ensureCrewRunPrefix(projectRoot);
			assert.isTrue(a.startsWith(prefix), "the pane cwd sits under the resolved crew-run prefix");
			assert.strictEqual(prefix, realpathSync(crewRunRoot(projectRoot)));
		} finally {
			rmSync(projectRoot, {recursive: true, force: true});
		}
	});
});
