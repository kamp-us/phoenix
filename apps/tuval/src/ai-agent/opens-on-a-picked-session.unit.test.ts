/**
 * The other arm of the fresh spawn: a process spawned *for* a session the operator picked out of
 * the session list comes up resuming it, never minting a second one beside it (epic #8070, ruling
 * 2). `./opens-on-spawn.unit.test.ts` holds the arm with no session named.
 *
 * The two are told apart by the replay and by nothing weaker. A fresh open replays no history; a
 * resumed one replays the script's own nine items, so a boot that quietly dropped the resume id
 * would come up `ready` on the same session id and still fail here. The second test is the other
 * half of that: a resume the store cannot find is a refusal on the process, not a fresh session
 * opened in its place.
 */

import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer} from "effect";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {NodeId} from "../ports/graph.ts";
import {ProcessPorts, unwired} from "../ports/index.ts";
import {Processes} from "../process/Processes.ts";
import type {ProcessHandle} from "../process/process.ts";
import {ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {type AiAgentSessionState, isAiAgentSessionState} from "./core/index.ts";
import {SessionOpening} from "./opening.ts";
import {aiAgentProgram} from "./program.ts";
import {history, plainReply, SESSION_ID} from "./service/fixtures/scripts.ts";
import {ScriptedAiAgent} from "./service/index.ts";

const PROGRAM = "ai-agent-picked-session-test";
/** The row's own default, which a picked session must NOT be opened in. */
const ROW_CWD = "/work";
const PICKED_CWD = "/picked/repo";

const row = aiAgentProgram({
	id: PROGRAM,
	layer: ScriptedAiAgent.layer(plainReply),
	config: {cwd: ROW_CWD},
});

const kernel = Processes.layer.pipe(
	Layer.provideMerge(Checkpoints.layer(memoryStores())),
	Layer.provideMerge(Layer.orDie(Registry.layer([row]))),
);

const eventually = (what: string, check: () => boolean) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 400 && !check(); attempt += 1) yield* Effect.sleep("5 millis");
		assert.isTrue(check(), `timed out after 2s waiting for ${what}`);
	});

const sessionOf = (handle: ProcessHandle): AiAgentSessionState => {
	const state = handle.getState();
	assert.isTrue(isAiAgentSessionState(state), "the process is not holding an agent session state");
	return state as AiAgentSessionState;
};

/** Exactly what `shell/picker/open.ts` hands a spawn it is making for a picked session. */
const onASpawnFor = <A, E>(
	opening: {readonly cwd: string; readonly resume: string},
	body: (handle: ProcessHandle) => Effect.Effect<A, E>,
) =>
	Effect.gen(function* () {
		const processes = yield* Processes;
		const handle = yield* processes.spawn(ProgramId.make(PROGRAM), {
			services: Context.merge(
				Context.make(ProcessPorts, unwired(NodeId.make("test"))),
				Context.make(SessionOpening, opening),
			),
		});
		return yield* body(handle);
	}).pipe(Effect.scoped, Effect.provide(kernel));

describe("an agent spawned for a session the operator picked", () => {
	it.live("comes up resuming that session in that folder, replaying its history", () =>
		onASpawnFor({cwd: PICKED_CWD, resume: SESSION_ID}, (handle) =>
			Effect.gen(function* () {
				// The gate is the replayed history rather than the phase: the layer emits the replay
				// before it starts, so the events are buffered and the Sub drains them after
				// `started` — a phase gate would read the transcript mid-drain.
				yield* eventually(
					"the resumed session's history to land on the transcript",
					() => sessionOf(handle).transcript.items.length === history.length,
				);
				const session = sessionOf(handle);
				assert.isNull(session.failure, "resuming the picked session recorded a refusal");
				assert.strictEqual(session.sessionId, SESSION_ID);
				assert.strictEqual(session.cwd, PICKED_CWD);
				// The replay is what a fresh open does not do, so it is the whole difference.
				assert.deepStrictEqual(
					session.transcript.items.map((item) => item.id as string),
					history.map((item) => item.id as string),
				);
			}),
		),
	);

	it.live("refuses a session the store no longer holds rather than opening a fresh one", () =>
		onASpawnFor({cwd: PICKED_CWD, resume: "gone"}, (handle) =>
			Effect.gen(function* () {
				yield* eventually(
					"the refused resume to land on the session",
					() => sessionOf(handle).failure !== null,
				);
				const session = sessionOf(handle);
				assert.strictEqual(session.failure?.reason, "session-not-found");
				assert.isNull(session.sessionId, "a refused resume left a session id behind");
			}),
		),
	);
});
