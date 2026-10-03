/**
 * Which rows are AI-agent backends: the enumeration is derived from the registry, not maintained,
 * so a backend appearing is a fact about the config rather than an edit to `backends.ts`. The union
 * of their stores, its order and a store that cannot be read are proven where a caller reaches
 * them, through the session-list spell (`./session-list.unit.test.ts`).
 */

import {type Cmd, defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {
	aiAgentBackends,
	isAiAgentBackend,
	listAiAgentSessions,
} from "@kampus/tuval-sdk/kernel/ai-agent/backends";
import {aiAgentProgram} from "@kampus/tuval-sdk/kernel/ai-agent/program";
import {models, modes, thinking} from "@kampus/tuval-sdk/kernel/ai-agent/service/fixtures/scripts";
import {
	type AgentScript,
	type ListError,
	ScriptedAiAgent,
	type SessionSummary,
} from "@kampus/tuval-sdk/kernel/ai-agent/service/index";
import {type AnyProgram, type Program, ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {Registry} from "@kampus/tuval-sdk/kernel/registry/Registry";
import {Context, Effect} from "effect";
import {showsInAWindow} from "../shell/picker/entries.ts";

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

	it.effect("answers nothing at all when no backend is registered", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* read([plainRow("counter")]), {sessions: [], failures: []});
		}),
	);
});
