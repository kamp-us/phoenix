/**
 * What a Pi send owes the window before its turn ends (#8018).
 *
 * The founder sent a message in a Pi window and saw nothing until the reply landed. The layer was
 * the whole of it: the pin answers a `prompt` request with the snapshot the turn ended on, the
 * generic host awaits a Cmd handler before publishing the commit that handler came from, and
 * `enqueue` holds one transition permit for the whole step — so a `prompt` that resolved at the
 * turn's end held back the operator's own message *and* every event the turn produced.
 *
 * So this hosts the row as a real process over the real Pi mapping layer, on a pin whose `prompt`
 * does not settle until a latch opens, and reads the published states off `ProcessTable.changes` —
 * the same stream the chat window renders from (`shell/chat/ChatWindow.tsx`). The assertions are
 * about the host's publish rather than the port emits, because a window paints off process state.
 *
 * The host is not the subject and is unchanged: `commit` still runs `runInterpret` before
 * `onCommit`, and `enqueue` still takes one permit. What changed is that the layer no longer parks
 * inside either.
 */

import type {SessionSnapshot} from "@earendil-works/pi-protocol";
import {assert, describe, it} from "@effect/vitest";
import {Context, Deferred, Effect, Layer, Queue, Stream} from "effect";
import {type AiAgentSessionState, isAiAgentSessionState} from "../../ai-agent/core/index.ts";
import {aiAgentPortNames} from "../../ai-agent/handlers/index.ts";
import {aiAgentProgram} from "../../ai-agent/program.ts";
import {Checkpoints} from "../../durability/Checkpoints.ts";
import {memoryStores} from "../../durability/stores.ts";
import {NodeId} from "../../ports/graph.ts";
import {PortNotWired, ProcessPorts} from "../../ports/index.ts";
import {Processes, type ProcessHandle, ProcessTable} from "../../process/index.ts";
import {ProgramId} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import {
	type PiClientApi,
	PiClientService,
	type PiSessionRef,
	SessionLocked,
} from "../client/index.ts";
import {aiAgentOverClient} from "./PiAiAgent.ts";

const PROGRAM = "pi-ai-agent-publishes-the-send-test";
const CWD = "/tuval/send";
const TRANSPORT_ERROR = "tuval/ai-agent/TransportError";
const SESSION: PiSessionRef = {id: "session-8018", cwd: CWD};

const wired: ReadonlySet<string> = new Set(Object.values(aiAgentPortNames));

const ports = ProcessPorts.of({
	emit: (port) =>
		wired.has(port)
			? Effect.succeed([])
			: Effect.fail(new PortNotWired({node: NodeId.make("test"), port})),
});

const snapshotOf = (
	transcript: SessionSnapshot["transcript"],
	phase: SessionSnapshot["phase"],
	revision: number,
): SessionSnapshot => ({
	id: SESSION.id,
	cwd: CWD,
	createdAt: 0,
	updatedAt: 0,
	phase,
	model: {provider: "faux", id: "faux-1"},
	thinkingLevel: "off",
	attached: true,
	locked: false,
	revision,
	transcript,
	queuedSteer: [],
	queuedSteerCount: 0,
});

const reply = (text: string): SessionSnapshot["transcript"][number] => ({
	id: "pi-item-1",
	role: "assistant",
	content: [{type: "text", text}],
	model: {provider: "faux", id: "faux-1"},
	timestamp: 11,
	status: "complete",
	stopReason: "stop",
});

interface Pin {
	readonly services: Context.Context<never>;
	/** Read synchronously: every wait below polls, and an Effect read cannot ride a predicate. */
	readonly sends: ReadonlyArray<string>;
	readonly push: (snapshot: SessionSnapshot) => Effect.Effect<void>;
	readonly endTurn: Effect.Effect<void>;
	/**
	 * Whether the turn has ended. Read rather than inferred: every assertion here is worth nothing
	 * unless the turn really was still open when it ran, and this is what proves it.
	 */
	readonly hasEnded: () => boolean;
}

/** A `PiClientService` whose turn ends only when the test says so. */
const pin = (options: {readonly refuse?: boolean} = {}): Effect.Effect<Pin> =>
	Effect.gen(function* () {
		const sends: Array<string> = [];
		const turn = yield* Deferred.make<void>();
		const pushed = yield* Queue.unbounded<SessionSnapshot>();
		const state = {ended: false};

		const api: PiClientApi = {
			connect: Effect.void,
			reconnect: Effect.void,
			connected: Effect.succeed(true),
			createSession: () => Effect.succeed(SESSION),
			attachSession: () => Effect.succeed(SESSION),
			prompt: (_sessionId, text) =>
				Effect.gen(function* () {
					sends.push(text);
					if (options.refuse === true) {
						return yield* new SessionLocked({
							sessionId: SESSION.id,
							detail: "another connection holds the lease",
						});
					}
					yield* Deferred.await(turn);
					state.ended = true;
					return snapshotOf([], "idle", 9);
				}),
			abort: () => Effect.never,
			snapshots: () => Stream.fromQueue(pushed),
			disconnections: Stream.never,
		};

		return {
			services: Context.add(Context.make(ProcessPorts, ports), PiClientService, api),
			get sends() {
				return sends;
			},
			push: (snapshot) => Effect.asVoid(Queue.offer(pushed, snapshot)),
			endTurn: Effect.asVoid(Deferred.succeed(turn, undefined)),
			hasEnded: () => state.ended,
		};
	});

const row = aiAgentProgram({
	id: PROGRAM,
	layer: aiAgentOverClient(),
	config: {cwd: CWD},
});

const kernel = Processes.layer.pipe(
	Layer.provideMerge(Checkpoints.layer(memoryStores())),
	Layer.provideMerge(Registry.layer([row])),
);

/** A spent budget asserts rather than falling through, so a timeout names what it waited for. */
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

const userText = (state: AiAgentSessionState): ReadonlyArray<string> =>
	state.transcript.items.flatMap((item) => (item.kind === "user" ? [item.text] : []));

const assistantText = (state: AiAgentSessionState): ReadonlyArray<string> =>
	state.transcript.items.flatMap((item) => (item.kind === "assistant" ? [item.text] : []));

const prompted = (handle: ProcessHandle, text: string, key: string, timestamp: number) =>
	handle.dispatch({type: "prompt", text, key, timestamp}).pipe(Effect.orDie);

/**
 * The row, spawned and ready, with every state it publishes collected from before the spawn — so
 * nothing this watcher misses can be mistaken for a commit that never published.
 */
const onAReadySession = <A, E>(
	options: {readonly refuse?: boolean},
	body: (
		handle: ProcessHandle,
		pinned: Pin,
		published: ReadonlyArray<AiAgentSessionState>,
	) => Effect.Effect<A, E>,
) =>
	Effect.gen(function* () {
		const pinned = yield* pin(options);
		const table = yield* ProcessTable;
		const published: Array<AiAgentSessionState> = [];
		yield* Effect.forkScoped(
			Stream.runForEach(table.changes, (change) =>
				Effect.sync(() => {
					if (change.kind !== "state-changed") return;
					const state = change.row.stateSummary().state;
					if (isAiAgentSessionState(state)) published.push(state);
				}),
			),
		);

		const processes = yield* Processes;
		const handle = yield* processes.spawn(ProgramId.make(PROGRAM), {services: pinned.services});
		yield* eventually(
			"the spawned session to reach ready",
			() => sessionOf(handle).phase === "ready",
		);
		// The opening commits are the watcher's own handshake: it is subscribed by the time one of
		// them has landed, so a later miss is the publish and not the subscription.
		yield* eventually("the watcher to see the opening commits", () => published.length > 0);

		return yield* body(handle, pinned, published);
	}).pipe(Effect.scoped, Effect.provide(kernel));

describe("a Pi send whose turn has not ended", () => {
	it.live("publishes the operator's own message at the send", () =>
		onAReadySession({}, (handle, pinned, published) =>
			Effect.gen(function* () {
				// Forked: on the shape this test exists to refuse, `dispatch` parks for the whole
				// turn, and a failed assertion says more than a suite timeout.
				yield* Effect.forkChild(prompted(handle, "hello", "k1", 1));

				yield* eventually("the operator's message on a published state", () =>
					published.some((state) => userText(state).includes("hello")),
				);
				assert.isFalse(
					pinned.hasEnded(),
					"the turn ended before the assertion could mean anything",
				);
				// The send rides its own fiber now, so it lands after the publish rather than before
				// it — which is the whole point, and why this waits rather than reads.
				yield* eventually("the send to reach the pin", () => pinned.sends.length > 0);
				assert.deepStrictEqual(pinned.sends, ["hello"], "the prompt reached the pin once");

				yield* pinned.endTurn;
			}),
		),
	);

	it.live("publishes a transcript item that arrives mid-turn", () =>
		onAReadySession({}, (handle, pinned, published) =>
			Effect.gen(function* () {
				yield* Effect.forkChild(prompted(handle, "hello", "k1", 1));
				yield* eventually("the operator's message on a published state", () =>
					published.some((state) => userText(state).includes("hello")),
				);

				// A streamed reply pushed while the turn is still open: `turn` rather than `idle`,
				// so nothing about this snapshot says the turn ended.
				yield* pinned.push(snapshotOf([reply("thinking out loud")], "turn", 2));

				yield* eventually("the mid-turn reply on a published state", () =>
					published.some((state) => assistantText(state).includes("thinking out loud")),
				);
				assert.isFalse(
					pinned.hasEnded(),
					"the turn ended before the assertion could mean anything",
				);

				yield* pinned.endTurn;
			}),
		),
	);
});

describe("a Pi send the pin refuses", () => {
	it.live("reaches the window as a failed Msg and gives the idempotency key back", () =>
		onAReadySession({refuse: true}, (handle, pinned) =>
			Effect.gen(function* () {
				yield* prompted(handle, "hello", "k1", 1);

				yield* eventually(
					"the refusal to reach the window",
					() => sessionOf(handle).failure !== null,
				);
				const failure = sessionOf(handle).failure;
				assert.strictEqual(failure?.tag, TRANSPORT_ERROR);
				assert.strictEqual(failure?.reason, "refused");
				assert.strictEqual(
					sessionOf(handle).phase,
					"ready",
					"a refused send leaves the session where it was rather than stuck prompting",
				);

				// The same key again: one the refusal had not given back would drop this send
				// silently, and the operator's retry would reach nothing.
				yield* prompted(handle, "hello", "k1", 2);
				yield* eventually("the retry to reach the pin", () => pinned.sends.length === 2);
				assert.deepStrictEqual(pinned.sends, ["hello", "hello"]);
			}),
		),
	);
});
