/**
 * The persisted local-scope registrar (#3444): the pure config transforms + the locked atomic RMW.
 *
 * The transforms (`applyLocalEntries` / `reapLocalEntries`) are tested with no IO — they only reshape
 * a parsed `~/.claude.json` value. The IO (`withLockedClaudeConfig` and the register/reap wrappers) is
 * tested against an INJECTED temp config path + a temp project root: a unit test NEVER touches the
 * operator's real `~/.claude.json`. The lock + atomic-write are proven under real contention.
 */
import {randomUUID} from "node:crypto";
import {existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import type {CrewServerConfig} from "./bind.ts";
import {
	applyLocalEntries,
	type CrewLocalEntry,
	crewRunRoot,
	ensureCrewRunPrefix,
	ensurePaneCwd,
	LocalScopeWriteError,
	reapCrewLocalScope,
	reapLocalEntries,
	registerCrewLocalScope,
} from "./register-local-scope.ts";

const SERVER = "@kampus/pipeline-crew-mcp";
const cfg = (role: string): CrewServerConfig => ({
	command: "/usr/bin/node",
	args: ["/abs/bin.ts", "session", "--role", role],
});
const entry = (cwd: string, role: string): CrewLocalEntry => ({
	cwd,
	serverName: SERVER,
	serverConfig: cfg(role),
});

const tempConfig = (initial: unknown = {}): string => {
	const dir = mkdtempSync(join(tmpdir(), "crew-localscope-"));
	const path = join(dir, ".claude.json");
	writeFileSync(path, JSON.stringify(initial));
	return path;
};

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8"));

describe("register-local-scope — pure transforms", () => {
	it("applyLocalEntries writes projects[cwd].mcpServers[name], one isolated entry per cwd", () => {
		const out = applyLocalEntries({}, [entry("/cwd/a", "cos"), entry("/cwd/b", "em")]);
		const projects = out.projects as Record<string, unknown>;
		const a = projects["/cwd/a"] as {mcpServers: Record<string, unknown>};
		const b = projects["/cwd/b"] as {mcpServers: Record<string, unknown>};
		// each pane's server lives ONLY under its own cwd key — the fact-#2 isolation the fix rests on.
		assert.deepStrictEqual(a.mcpServers, {[SERVER]: cfg("cos")});
		assert.deepStrictEqual(b.mcpServers, {[SERVER]: cfg("em")});
		assert.notProperty(a.mcpServers, "__none");
	});

	it("applyLocalEntries preserves sibling projects + other servers untouched", () => {
		const root = {
			projects: {
				"/other": {mcpServers: {"some-other": {command: "x", args: []}}, history: [1]},
				"/cwd/a": {mcpServers: {keep: {command: "k", args: []}}},
			},
			topLevel: "unchanged",
		};
		const out = applyLocalEntries(root, [entry("/cwd/a", "cos")]);
		const projects = out.projects as Record<string, unknown>;
		const cwdA = projects["/cwd/a"] as {mcpServers: Record<string, unknown>};
		assert.strictEqual(out.topLevel, "unchanged");
		// the untouched project + its history survive; the touched one keeps its pre-existing server AND gains ours.
		assert.deepStrictEqual(projects["/other"], {
			mcpServers: {"some-other": {command: "x", args: []}},
			history: [1],
		});
		assert.deepStrictEqual(cwdA.mcpServers, {
			keep: {command: "k", args: []},
			[SERVER]: cfg("cos"),
		});
	});

	it("reapLocalEntries removes the crew server under the prefix, keeps everything else", () => {
		const root = {
			projects: {
				"/run/x/cos": {mcpServers: {[SERVER]: cfg("cos")}},
				"/run/x/em": {mcpServers: {[SERVER]: cfg("em"), other: {command: "o", args: []}}},
				"/elsewhere": {mcpServers: {[SERVER]: cfg("nope")}, history: [1]},
			},
		};
		const out = reapLocalEntries(root, "/run", SERVER);
		const projects = out.projects as Record<string, unknown>;
		// a crew-run project whose only server was ours is dropped entirely; one with another server keeps it.
		assert.notProperty(projects, "/run/x/cos");
		assert.deepStrictEqual(projects["/run/x/em"], {mcpServers: {other: {command: "o", args: []}}});
		// a project OUTSIDE the prefix is never touched, even if it (coincidentally) carries the same server key.
		assert.deepStrictEqual(projects["/elsewhere"], {
			mcpServers: {[SERVER]: cfg("nope")},
			history: [1],
		});
	});

	it("reapLocalEntries is idempotent and prefix-segment-aware (no bare-substring false match)", () => {
		const root = {projects: {"/run-sibling/x": {mcpServers: {[SERVER]: cfg("x")}}}};
		// `/run-sibling` is NOT under prefix `/run` — a segment-aware match must leave it alone.
		const once = reapLocalEntries(root, "/run", SERVER);
		assert.property(once.projects as Record<string, unknown>, "/run-sibling/x");
		// a second reap over an already-swept tree is a clean no-op.
		assert.deepStrictEqual(reapLocalEntries(once, "/run", SERVER), once);
	});
});

describe("register-local-scope — locked atomic RMW (injected temp path, never real ~/.claude.json)", () => {
	it.live(
		"registerCrewLocalScope writes an entry a re-read sees, preserving prior file content",
		() =>
			Effect.gen(function* () {
				const path = tempConfig({
					projects: {"/pre": {mcpServers: {keep: {command: "k", args: []}}}},
					top: 1,
				});
				yield* registerCrewLocalScope([entry("/cwd/a", "cos")], {configPath: path});

				const json = readJson(path);
				assert.strictEqual(json.top, 1);
				const projects = json.projects as Record<string, unknown>;
				const pre = projects["/pre"] as {mcpServers: Record<string, unknown>};
				const cwdA = projects["/cwd/a"] as {mcpServers: Record<string, unknown>};
				assert.deepStrictEqual(pre.mcpServers, {keep: {command: "k", args: []}});
				assert.deepStrictEqual(cwdA.mcpServers, {[SERVER]: cfg("cos")});
				rmSync(path, {recursive: true, force: true});
			}),
	);

	it.live("register then reap round-trips the entry back out", () =>
		Effect.gen(function* () {
			const path = tempConfig();
			yield* registerCrewLocalScope([entry("/run/a", "cos"), entry("/run/b", "em")], {
				configPath: path,
			});
			assert.strictEqual(Object.keys((readJson(path).projects as object) ?? {}).length, 2);

			yield* reapCrewLocalScope("/run", SERVER, {configPath: path});
			assert.deepStrictEqual(readJson(path).projects, {});
			rmSync(path, {recursive: true, force: true});
		}),
	);

	it.live("seeds a missing config file rather than failing, then writes into it", () =>
		Effect.gen(function* () {
			const dir = mkdtempSync(join(tmpdir(), "crew-localscope-"));
			const path = join(dir, ".claude.json"); // does NOT exist yet
			yield* registerCrewLocalScope([entry("/cwd/a", "cos")], {configPath: path});
			assert.isTrue(existsSync(path));
			assert.property(readJson(path).projects as Record<string, unknown>, "/cwd/a");
			rmSync(dir, {recursive: true, force: true});
		}),
	);

	it.live("fails closed with LocalScopeWriteError on malformed JSON in the config file", () =>
		Effect.gen(function* () {
			const dir = mkdtempSync(join(tmpdir(), "crew-localscope-"));
			const path = join(dir, ".claude.json");
			writeFileSync(path, "{ not json ");
			const err = yield* Effect.flip(
				registerCrewLocalScope([entry("/cwd/a", "cos")], {configPath: path}),
			);
			assert.instanceOf(err, LocalScopeWriteError);
			assert.strictEqual(err.configPath, path);
			assert.include(err.reason, "malformed JSON");
			rmSync(dir, {recursive: true, force: true});
		}),
	);

	it.live("the lock serializes concurrent writers — every entry lands (no lost update)", () =>
		Effect.gen(function* () {
			const path = tempConfig();
			// 6 concurrent registers of distinct cwds; proper-lockfile forces them to serialize, so the
			// atomic RMW never loses an update — all 6 survive in the final file.
			const writes = Array.from({length: 6}, (_, i) =>
				registerCrewLocalScope([entry(`/cwd/${i}`, `r${i}`)], {configPath: path}),
			);
			yield* Effect.all(writes, {concurrency: "unbounded"});

			const projects = readJson(path).projects as Record<string, unknown>;
			assert.strictEqual(Object.keys(projects).length, 6);
			for (let i = 0; i < 6; i++) assert.property(projects, `/cwd/${i}`);
			rmSync(path, {recursive: true, force: true});
		}),
	);
});

describe("register-local-scope — per-pane cwd isolation", () => {
	it("ensurePaneCwd mints a distinct, existing, resolved dir per (runId, pane); same inputs are stable", () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "crew-proj-"));
		try {
			const runId = randomUUID().slice(0, 8);
			const a = ensurePaneCwd(projectRoot, runId, "chief-of-staff");
			const b = ensurePaneCwd(projectRoot, runId, "engineering-manager");
			const aAgain = ensurePaneCwd(projectRoot, runId, "chief-of-staff");

			assert.notStrictEqual(a, b, "distinct panes get distinct cwds (isolated projects[] keys)");
			assert.strictEqual(a, aAgain, "the same pane resolves to the same cwd (idempotent)");
			assert.isTrue(existsSync(a) && existsSync(b), "both cwds exist on disk (git-valid dirs)");
			// realpath'd + under the crew-run prefix, so it matches how claude keys projects[] by resolved cwd.
			const prefix = ensureCrewRunPrefix(projectRoot);
			assert.isTrue(a.startsWith(prefix), "the pane cwd sits under the resolved crew-run prefix");
			assert.strictEqual(prefix, realpathSync(crewRunRoot(projectRoot)));
		} finally {
			rmSync(projectRoot, {recursive: true, force: true});
		}
	});
});
