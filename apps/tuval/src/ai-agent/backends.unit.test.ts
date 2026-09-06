/**
 * The enumeration is derived, not maintained: these proofs register rows and read the answer back
 * off `Registry.list`, so a third backend appearing is a fact about the config rather than about an
 * edit to `backends.ts`. The one thing every test here holds is that a backend's own trouble stays
 * its own — a store that cannot be read is a reported failure beside the other backends' rows, and
 * never an empty list standing in for "you have no sessions".
 */

import {type Cmd, defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Cause, Context, Effect, Option} from "effect";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {showsInAWindow} from "../shell/picker/entries.ts";
import {aiAgentBackends, isAiAgentBackend, listAiAgentSessions} from "./backends.ts";
import {aiAgentProgram} from "./program.ts";
import {models, modes, thinking} from "./service/fixtures/scripts.ts";
import {
	type AgentScript,
	ListError,
	ScriptedAiAgent,
	type SessionSummary,
	sessionSummary,
} from "./service/index.ts";

type CountState = {readonly count: number};
type CountMsg = {readonly type: "tick"};

const core = defineMachine<CountState, CountMsg, Cmd<never>, never, unknown>({
	init: (loaded) => [loaded ?? {count: 0}, []],
	update: {tick: (state) => [{count: state.count + 1}, []]},
});

/** A row that is no kind of agent: the demo counter's shape, with a renderer so it is windowed. */
const plainRow = (id: string): AnyProgram =>
	({
		id: ProgramId.make(id),
		core,
		ports: {},
		handlers: {},
		capabilities: [],
		renderer: {kind: "host-native", ref: `tuval/${id}`},
		identity: {package: "@kampus/tuval", program: id, version: "1.0.0", digest: `sha256:${id}`},
		placement: {host: "local"},
	}) satisfies Program<CountState, CountMsg, Cmd<never>, never, unknown, never, never>;

const at = (offset: number): number => 1_760_000_000_000 + offset;

const session = (id: string, backend: string, lastModified: number): SessionSummary =>
	sessionSummary({sessionId: id, backend, lastModified});

/**
 * A backend row, headless: nothing here declares a renderer, and the row is a backend anyway. Its
 * whole store is the script's `sessions`, so a `ListError` there is a store that could not be read.
 */
const backendRow = (id: string, store: ReadonlyArray<SessionSummary> | ListError) => {
	const script: AgentScript = {
		sessionId: `${id}-live`,
		history: [],
		modes,
		models,
		thinking,
		turns: [],
		interrupt: [],
		sessions: store,
	};
	return aiAgentProgram({
		id,
		layer: ScriptedAiAgent.layer(script),
		config: {cwd: "/workspace/phoenix"},
	});
};

const read = (rows: ReadonlyArray<AnyProgram>) =>
	listAiAgentSessions(Context.empty()).pipe(Effect.provide(Registry.layer(rows)));

const ids = (sessions: ReadonlyArray<SessionSummary>): ReadonlyArray<string> =>
	sessions.map((row) => row.sessionId);

describe("ai-agent backend enumeration", () => {
	it("admits a row that declares a backend and leaves every other row out", () => {
		const agent = backendRow("pi-session", []);
		const other = plainRow("counter");
		assert.isTrue(isAiAgentBackend(agent));
		assert.isFalse(isAiAgentBackend(other));
		assert.deepStrictEqual(aiAgentBackends([other, agent, plainRow("log")]), [agent]);
	});

	// The renderer is `showsInAWindow`'s question and stays there: a headless agent row owns a
	// session store exactly like a windowed one, so the two predicates disagree about it on purpose.
	it("enumerates a backend with no renderer, which shows in no window", () => {
		const headless = backendRow("scripted-session", []);
		assert.isFalse(showsInAWindow(headless));
		assert.isTrue(isAiAgentBackend(headless));
	});

	it.effect("answers off the registry, so a third backend is registration and nothing else", () =>
		Effect.gen(function* () {
			const two = [
				backendRow("pi-session", [session("pi-1", "pi", at(1))]),
				backendRow("claude-session", [session("claude-1", "claude", at(2))]),
			];
			const before = yield* read([plainRow("counter"), ...two]);
			assert.deepStrictEqual(ids(before.sessions), ["claude-1", "pi-1"]);

			const three = [...two, backendRow("scripted-session", [session("s-1", "scripted", at(3))])];
			const after = yield* read([plainRow("counter"), ...three]);
			assert.deepStrictEqual(ids(after.sessions), ["s-1", "claude-1", "pi-1"]);
			assert.deepStrictEqual(after.failures, []);
		}),
	);

	it.effect("unions the answering backends newest first, whatever order they registered in", () =>
		Effect.gen(function* () {
			const answer = yield* read([
				backendRow("pi-session", [session("pi-old", "pi", at(1)), session("pi-new", "pi", at(9))]),
				backendRow("claude-session", [session("claude-mid", "claude", at(5))]),
			]);
			assert.deepStrictEqual(ids(answer.sessions), ["pi-new", "claude-mid", "pi-old"]);
		}),
	);

	it.effect("reports the backend that could not look and keeps the one that did", () =>
		Effect.gen(function* () {
			const broken = new ListError({
				reason: "store-unreadable",
				detail: "the scripted store is not on disk",
			});
			const answer = yield* read([
				backendRow("pi-session", broken),
				backendRow("claude-session", [session("claude-1", "claude", at(2))]),
			]);
			assert.deepStrictEqual(ids(answer.sessions), ["claude-1"]);
			assert.deepStrictEqual(
				answer.failures.map((failure) => failure.programId),
				["pi-session"],
			);
			assert.deepStrictEqual(
				answer.failures.map((failure) => failure.provenance),
				["@kampus/tuval/pi-session@1.0.0 (sha256:pi-session)"],
			);
			assert.deepStrictEqual(
				answer.failures.map((failure) =>
					Option.getOrUndefined(Cause.findErrorOption(failure.cause)),
				),
				[broken],
			);
		}),
	);

	it.effect("answers nothing at all when no backend is registered", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* read([plainRow("counter")]), {sessions: [], failures: []});
		}),
	);
});
