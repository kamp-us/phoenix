/**
 * The delivery half of a config reload (#7952, #7509 ruling 3): a re-read config reaches the
 * processes that are already running, through the row's own `configChanged`.
 *
 * The whole proof drives the real `Booted.reload`, in the shape `./reload-proof.unit.test.ts` uses
 * — the config layer is `config-fixtures/reloadable-claude.ts`, whose generation is read out of a
 * JSON file this test rewrites between loads, so a second load is a genuinely different config.
 * Nothing here reaches into the dispatch: it reads the mode the live session ended up in.
 */

import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, type FileSystem, type Scope} from "effect";
import {afterEach} from "vitest";
import {type AiAgentSessionState, isAiAgentSessionState} from "./ai-agent/core/index.ts";
import {Mode} from "./ai-agent/ports/index.ts";
import {type Booted, boot, projectDir} from "./boot.ts";
import type {DeclaredClaudeConfig} from "./config-fixtures/reloadable-claude.ts";
import {ProcessTable} from "./process/ProcessTable.ts";
import {ProcessId} from "./process/process.ts";

const layer = fileURLToPath(new URL("./config-fixtures/reloadable-claude.ts", import.meta.url));

const AGENT = ProcessId.make("agent");

const tempDirs: string[] = [];
const freshDir = (prefix: string) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
	delete process.env.TUVAL_CLAUDE_RELOAD_FIXTURE;
});

const declare = (path: string, config: DeclaredClaudeConfig) =>
	writeFileSync(path, JSON.stringify(config));

/** A booted app over the claude layer, its fixture file already holding `first`. */
const bootClaude = Effect.fnUntraced(function* (first: DeclaredClaudeConfig) {
	const project = freshDir("tuval-claude-reload-");
	mkdirSync(join(projectDir(project), "processes"), {recursive: true});
	const declaration = join(freshDir("tuval-claude-declared-"), "config.json");
	declare(declaration, first);
	process.env.TUVAL_CLAUDE_RELOAD_FIXTURE = declaration;
	const booted = yield* boot({global: layer, project});
	return {booted, declaration};
});

const sessionOf = (booted: Booted) =>
	ProcessTable.use((table) => table.get(AGENT)).pipe(
		Effect.map((row) => {
			const state = row.stateSummary().state;
			assert.isTrue(isAiAgentSessionState(state), "the agent process holds no session state");
			return state as AiAgentSessionState;
		}),
		Effect.provideContext(booted.kernel),
	);

/** A spent budget asserts rather than falling through, so a timeout names itself. */
const until = (
	booted: Booted,
	what: string,
	check: (session: AiAgentSessionState) => boolean,
): Effect.Effect<AiAgentSessionState, never, never> =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 400; attempt += 1) {
			const session = yield* sessionOf(booted);
			if (check(session)) return session;
			yield* Effect.sleep("5 millis");
		}
		return assert.fail(`timed out after 2s waiting for ${what}`);
	}).pipe(Effect.orDie);

/**
 * The session has to be live before a `setMode` is admissible, and it has to have folded the mode
 * its layer advertises — `ready` commits before that event lands, so a mode read at `ready` alone
 * is still `null` and no later mode could be told apart from it.
 */
const readySession = (booted: Booted) =>
	until(
		booted,
		"the spawned claude session to reach ready and fold its mode",
		(session) => session.phase === "ready" && session.modes.current !== null,
	);

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

describe("a config reload over live processes", () => {
	it.live("hands a running claude session the new permissionMode, as one setMode", () =>
		run(
			Effect.gen(function* () {
				const {booted, declaration} = yield* bootClaude({claude: {permissionMode: "default"}});
				const before = yield* readySession(booted);
				assert.strictEqual(
					before.modes.current,
					Mode.make("default"),
					"the scripted session did not open in the mode its script names",
				);

				declare(declaration, {claude: {permissionMode: "plan"}});
				const report = yield* booted.reload;

				assert.strictEqual(report.notified, 1, "the reload told the wrong number of processes");
				const after = yield* until(
					booted,
					"the reload's setMode to reach the session",
					(session) => session.modes.current === Mode.make("plan"),
				);
				assert.isNull(after.failure, "the session refused the mode the reload sent it");
			}),
		),
	);

	it.live("tells nobody when no row moved, and nobody when only a next-spawn field moved", () =>
		run(
			Effect.gen(function* () {
				const {booted, declaration} = yield* bootClaude({claude: {permissionMode: "acceptEdits"}});
				const opened = yield* readySession(booted);

				const unchanged = yield* booted.reload;
				assert.strictEqual(unchanged.notified, 0, "an unchanged config still told a process");

				declare(declaration, {
					claude: {
						permissionMode: "acceptEdits",
						model: "claude-opus-5",
						allowedTools: ["mcp__tuval__read"],
					},
				});
				const nextSpawnOnly = yield* booted.reload;
				assert.strictEqual(nextSpawnOnly.notified, 0, "a model or tool change was sent live");

				const session = yield* sessionOf(booted);
				assert.strictEqual(
					session.modes.current,
					opened.modes.current,
					"the live mode moved with no setMode behind it",
				);
			}),
		),
	);

	it.live("leaves a process whose row the reloaded config dropped running and untold", () =>
		run(
			Effect.gen(function* () {
				const {booted, declaration} = yield* bootClaude({claude: {permissionMode: "default"}});
				const opened = yield* readySession(booted);

				declare(declaration, {claude: {permissionMode: "plan"}, drop: true});
				const report = yield* booted.reload;

				assert.strictEqual(report.notified, 0, "a dropped row's process was still told");
				const session = yield* sessionOf(booted);
				assert.strictEqual(session.phase, "ready", "the process did not survive the reload");
				assert.strictEqual(
					session.modes.current,
					opened.modes.current,
					"a dropped row still applied live",
				);
			}),
		),
	);
});
