/**
 * The epic's no-go, proved against the real program row rather than a stand-in: a transcript item
 * still being written never reaches the checkpoint store (#8160).
 *
 * `durability.unit.test.ts` proves the host honours a `checkpointWorthy` predicate; this proves the
 * ai-agent program declares one, which is the half that was missing — without it every delta of a
 * streamed reply rewrote the transcript, and a stop mid-turn saved the half-written text as the
 * reply a restore comes back to.
 */

import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Schema} from "effect";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {parseSnapshot} from "../durability/snapshot.ts";
import {type CheckpointStores, memoryStores} from "../durability/stores.ts";
import {NodeId} from "../ports/graph.ts";
import {PortNotWired, ProcessPorts} from "../ports/index.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessId} from "../process/process.ts";
import {type AnyProgram, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {type AiAgentSessionState, isAiAgentSessionState} from "./core/index.ts";
import type {AgentEvent} from "./events.ts";
import {aiAgentPortNames} from "./handlers/index.ts";
import type {AssistantItem, TranscriptItem} from "./ports/index.ts";
import {aiAgentProgram} from "./program.ts";
import {models, modes, SESSION_ID, thinking} from "./service/fixtures/scripts.ts";
import {type AgentScript, ScriptedAiAgent} from "./service/index.ts";

const PROGRAM = "ai-agent-partial-checkpoint-test";
const PROCESS = ProcessId.make("agent-partial");
const CWD = "/work";
const REPLY = "a1";

const at = (offset: number): number => 1_760_000_000_000 + offset;

/** One `text` delta of the reply, under the id every later delta re-upserts. */
const delta = (text: string): AgentEvent => ({
	kind: "item",
	item: {kind: "assistant", id: REPLY, timestamp: at(2), text, partial: true} as TranscriptItem,
});

/** The last upsert, which drops the marker: absent means final (`ports/transcript-item.ts`). */
const settled: AgentEvent = {
	kind: "item",
	item: {kind: "assistant", id: REPLY, timestamp: at(2), text: "the whole reply"} as TranscriptItem,
};

const opening: ReadonlyArray<AgentEvent> = [
	{kind: "phase", phase: "prompting"},
	{
		kind: "item",
		item: {kind: "user", id: "u1", timestamp: at(1), text: "write it"} as TranscriptItem,
	},
];

/** A reply that streams and stops there: the mid-turn state a restart would otherwise save. */
const cutMidReply: ReadonlyArray<AgentEvent> = [...opening, delta("the "), delta("the whole ")];

/** The same reply, carried to its end — the state that *is* worth a write. */
const wholeReply: ReadonlyArray<AgentEvent> = [
	...cutMidReply,
	settled,
	{kind: "phase", phase: "ready"},
];

const script = (turn: ReadonlyArray<AgentEvent>): AgentScript => ({
	sessionId: SESSION_ID,
	history: [],
	modes,
	models,
	thinking,
	interrupt: [],
	turns: [{events: turn}],
});

const allPorts: ReadonlySet<string> = new Set(Object.values(aiAgentPortNames));

/** The window's end of every outbound port, reduced to "the payload left the process". */
const sink = ProcessPorts.of({
	emit: (port) =>
		allPorts.has(port)
			? Effect.succeed([])
			: Effect.fail(new PortNotWired({node: NodeId.make("test"), port})),
});

const row = (turn: ReadonlyArray<AgentEvent>): AnyProgram =>
	aiAgentProgram({
		id: PROGRAM,
		layer: ScriptedAiAgent.layer(script(turn)),
		config: {cwd: CWD},
	});

const kernel = (rows: ReadonlyArray<AnyProgram>, stores: CheckpointStores) =>
	Processes.layer.pipe(
		Layer.provideMerge(Checkpoints.layer(stores)),
		Layer.provideMerge(Registry.layer(rows)),
	);

const eventually = (check: () => boolean) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 400 && !check(); attempt += 1) yield* Effect.sleep("5 millis");
	});

const sessionOf = (state: unknown): AiAgentSessionState => {
	assert.isTrue(isAiAgentSessionState(state), "the process is not holding an agent session state");
	return state as AiAgentSessionState;
};

const repliesIn = (state: AiAgentSessionState): ReadonlyArray<AssistantItem> =>
	state.transcript.items.filter((item): item is AssistantItem => item.kind === "assistant");

class StoreRead extends Schema.TaggedError<StoreRead>()("StoreRead", {cause: Schema.Defect()}) {}

/** What the store holds for this process, or `null` when nothing has been written yet. */
const savedState = (stores: CheckpointStores): Effect.Effect<AiAgentSessionState | null> =>
	Effect.tryPromise({
		try: () => stores.snapshot(PROCESS).load(),
		catch: (cause) => new StoreRead({cause}),
	}).pipe(
		Effect.map((raw) => {
			const state = parseSnapshot(raw)?.state;
			return state === undefined ? null : sessionOf(state);
		}),
		Effect.orDie,
	);

/** Spawn the row at a fixed id, run the turn, and hold the process open until `body` returns. */
const runTurn = <A, E>(
	stores: CheckpointStores,
	turn: ReadonlyArray<AgentEvent>,
	body: (live: () => AiAgentSessionState) => Effect.Effect<A, E>,
) =>
	Effect.gen(function* () {
		const processes = yield* Processes;
		const handle = yield* processes.spawn(ProgramId.make(PROGRAM), {
			id: PROCESS,
			services: Context.make(ProcessPorts, sink),
		});
		yield* eventually(() => sessionOf(handle.getState()).modes.available.length > 0);
		yield* handle.dispatch({type: "prompt", text: "write it", key: "k1", timestamp: at(0)});
		return yield* body(() => sessionOf(handle.getState()));
	}).pipe(Effect.scoped, Effect.provide(kernel([row(turn)], stores)));

describe("a partial reply and the checkpoint store", () => {
	it.live("never reaches it, not even on the stop that ends the process mid-reply", () => {
		const stores = memoryStores();
		return Effect.gen(function* () {
			yield* runTurn(stores, cutMidReply, (live) =>
				Effect.gen(function* () {
					yield* eventually(() => repliesIn(live()).some((item) => item.partial === true));
					assert.deepStrictEqual(
						repliesIn(live()).map((item) => item.text),
						["the whole "],
						"the turn never streamed, so there is no partial state to refuse",
					);
					const saved = yield* savedState(stores);
					assert.isNotNull(saved, "nothing was ever checkpointed, so the gate proves nothing");
					assert.deepStrictEqual(repliesIn(saved as AiAgentSessionState), []);
				}),
			);

			// The scope above closed, which is the host's stop path — and a stop flushes a checkpoint.
			const afterStop = yield* savedState(stores);
			assert.deepStrictEqual(repliesIn(afterStop as AiAgentSessionState), []);
		});
	});

	it.live("lands whole once the last upsert drops the marker, so the gate is not a mute", () => {
		const stores = memoryStores();
		return Effect.gen(function* () {
			yield* runTurn(stores, wholeReply, (live) => eventually(() => live().phase === "ready"));

			const saved = yield* savedState(stores);
			assert.deepStrictEqual(
				repliesIn(saved as AiAgentSessionState).map((item) => item.text),
				["the whole reply"],
			);
			assert.isUndefined(repliesIn(saved as AiAgentSessionState)[0]?.partial);
		});
	});
});
