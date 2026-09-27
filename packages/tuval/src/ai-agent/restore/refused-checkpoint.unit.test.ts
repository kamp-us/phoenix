/**
 * A checkpoint the load refuses is never written over (#8112).
 *
 * Two boots over one seeded store. The first has to refuse the bytes without saving its own `gone`
 * state on top of them, and the second has to read the same bytes and refuse them again: before
 * the seal the refusal survived exactly one restart, because the saved `gone` state was itself a
 * readable session, `restore` dropped its `failure`, and the status line fell from the refusal
 * sentence to a bare "The session is gone."
 */

import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Schema} from "effect";
import {Checkpoints} from "../../durability/Checkpoints.ts";
import type {Snapshot} from "../../durability/snapshot.ts";
import {type CheckpointStores, memoryStores} from "../../durability/stores.ts";
import {NodeId} from "../../ports/graph.ts";
import {PortNotWired, ProcessPorts} from "../../ports/index.ts";
import {Processes} from "../../process/Processes.ts";
import {ProcessId} from "../../process/process.ts";
import {ProgramId} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import {checkpointUnreadable} from "../core/failures.ts";
import {type AiAgentSessionState, initialState, isAiAgentSessionState} from "../core/index.ts";
import {ItemId} from "../ports/index.ts";
import {aiAgentProgram} from "../program.ts";
import {plainReply} from "../service/fixtures/scripts.ts";
import {ScriptedAiAgent} from "../service/index.ts";

const PROGRAM = "ai-agent-refused-checkpoint-test";
const PROCESS = ProcessId.make("agent-refused");
const CWD = "/work";
const VERSION = "1.0.0";

/** One saved turn, so what the refusal would have destroyed is a transcript and not an empty state. */
const withATranscript = (sessionId: string): AiAgentSessionState => {
	const base = initialState(CWD);
	return {
		...base,
		sessionId,
		transcript: {
			...base.transcript,
			items: [
				{kind: "user", id: ItemId.make("u1"), timestamp: 1_760_000_000_000, text: "the work"},
			],
		},
	};
};

/**
 * A saved session with one field of a type the predicate refuses. Defaulting fills only what is
 * absent, so `commands` stays a number and the whole state stays unreadable — the false-negative
 * shape #8112 is about, standing in for a predicate that tightens under a transcript someone still
 * wants back. Everything else is a real session, so the refusal has exactly one cause.
 */
const refused: Snapshot = {
	programId: PROGRAM,
	version: VERSION,
	state: {...withATranscript("session-lost"), commands: 3},
};

const readable: Snapshot = {
	programId: PROGRAM,
	version: VERSION,
	state: withATranscript("session-kept"),
};

const row = aiAgentProgram({
	id: PROGRAM,
	layer: ScriptedAiAgent.layer(plainReply),
	config: {cwd: CWD},
	identity: {version: VERSION},
});

/** Nothing here dispatches, and a restored `init` emits no Cmds, so no port is ever reached. */
const ports = ProcessPorts.of({
	emit: (port) => Effect.fail(new PortNotWired({node: NodeId.make("test"), port})),
});

const kernel = (stores: CheckpointStores) =>
	Processes.layer.pipe(
		Layer.provideMerge(Checkpoints.layer(stores)),
		Layer.provideMerge(Registry.layer([row])),
	);

const sessionOf = (state: unknown): AiAgentSessionState => {
	assert.isTrue(isAiAgentSessionState(state), "the process is not holding an agent session state");
	return state as AiAgentSessionState;
};

/** One boot at the fixed id, closed at the end so the stop-save flushes too. */
const boot = (stores: CheckpointStores) =>
	Effect.gen(function* () {
		const processes = yield* Processes;
		const handle = yield* processes.spawn(ProgramId.make(PROGRAM), {
			id: PROCESS,
			services: Context.make(ProcessPorts, ports),
		});
		return sessionOf(handle.getState());
	}).pipe(Effect.scoped, Effect.provide(kernel(stores)));

class TestIo extends Schema.TaggedError<TestIo>()("TestIo", {cause: Schema.Defect()}) {}

const io = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({try: run, catch: (cause) => new TestIo({cause})});

const stored = (stores: CheckpointStores) => io(() => stores.snapshot(PROCESS).load());

describe("a checkpoint the agent's load refuses", () => {
	it.live("comes back refused on every boot, over bytes neither boot overwrote", () =>
		Effect.gen(function* () {
			const stores = memoryStores();
			yield* io(() => stores.snapshot(PROCESS).save(refused));

			const first = yield* boot(stores);
			assert.strictEqual(first.phase, "gone");
			assert.deepStrictEqual(first.failure, checkpointUnreadable);

			const second = yield* boot(stores);
			assert.strictEqual(second.phase, "gone");
			assert.deepStrictEqual(
				second.failure,
				checkpointUnreadable,
				"the second boot lost the refusal, so the window reads the bare gone line",
			);

			assert.deepStrictEqual(
				yield* stored(stores),
				refused,
				"the refused checkpoint was written over, so there is nothing left to diagnose",
			);
		}),
	);

	it.live("leaves a checkpoint that parses saved after init, as before", () =>
		Effect.gen(function* () {
			const stores = memoryStores();
			yield* io(() => stores.snapshot(PROCESS).save(readable));

			const restored = yield* boot(stores);
			assert.strictEqual(restored.sessionId, "session-kept");

			assert.deepStrictEqual(
				yield* stored(stores),
				{programId: PROGRAM, version: VERSION, state: restored},
				"a readable checkpoint no longer takes the save that follows init",
			);
		}),
	);
});
