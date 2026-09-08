/**
 * What a resume owes the window, over a stub `PiClientService` whose snapshot stream is a queue the
 * test pushes.
 *
 * Pi re-sends the whole transcript every revision, so the fold's projection is the only thing
 * standing between a reattach and a full replay of the session as live items. A restored process
 * comes back with that transcript already on screen, and the replay lands on top of the operator's
 * own newly typed turn, pushing it out of the 40-item window (#8369). A window opened on a session
 * out of the picker holds nothing, and the same replay is the only way its history paints — so both
 * halves are pinned here.
 *
 * What the restored process holds stops at the tail it was checkpointed with, so a turn the session
 * finished while the socket was down sits in the lease snapshot and on nobody's screen. Suppressing
 * the whole snapshot would bury it for the life of the session, which is why the seed cuts at that
 * tail rather than at the snapshot — and why it suppresses against the caller's own copy of each
 * row, so one that settled under the cut while the transport was gone still emits (#8374).
 *
 * What the operator is shown and what they are charged come apart here, and both are pinned. A cost
 * is folded under its turn's id, so a resume may restate a turn the process already counted without
 * moving the totals — the last two cases walk that in both directions.
 */

import {assert, describe, it} from "@effect/vitest";
import {type Cause, Effect, Layer, Option, Queue, Stream} from "effect";
import {
	type AiAgentSessionState,
	foldEvent,
	initialState,
	restore,
	usageTotals,
} from "../../ai-agent/core/index.ts";
import type {TranscriptItem} from "../../ai-agent/ports/index.ts";
import type {AgentEvent, Phase, TransportError} from "../../ai-agent/service/index.ts";
import {TuvalAiAgent} from "../../ai-agent/service/index.ts";
import {type PiClientApi, PiClientService, type PiSessionRef} from "../client/index.ts";
import type {TranscriptItem as PiTranscriptItem, SessionSnapshot} from "../wire/index.ts";
import {itemsOf} from "./items.ts";
import {aiAgentOverClient} from "./PiAiAgent.ts";

const CWD = "/tuval/resume";
const SESSION: PiSessionRef = {
	id: "session-8369",
	cwd: CWD,
	model: {provider: "faux", id: "faux-1"},
	thinkingLevel: "off",
};

const user: PiTranscriptItem = {
	id: "item-0",
	role: "user",
	content: [{type: "text", text: "say hello"}],
	timestamp: 10,
};

const reply: PiTranscriptItem = {
	id: "item-1",
	role: "assistant",
	content: [{type: "text", text: "hello"}],
	model: SESSION.model,
	timestamp: 11,
	status: "complete",
	stopReason: "stop",
	usage: {
		input: 11,
		output: 22,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 33,
		cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.42},
	},
};

const sent: PiTranscriptItem = {
	id: "item-2",
	role: "user",
	content: [{type: "text", text: "and again"}],
	timestamp: 12,
};

const snapshot = (
	transcript: ReadonlyArray<PiTranscriptItem>,
	phase: SessionSnapshot["phase"],
	revision: number,
): SessionSnapshot => ({
	id: SESSION.id,
	cwd: CWD,
	createdAt: 0,
	updatedAt: 0,
	phase,
	model: SESSION.model,
	thinkingLevel: "off",
	attached: true,
	locked: false,
	revision,
	transcript: [...transcript],
	queuedSteer: [],
	queuedSteerCount: 0,
});

/** The transcript the session already had when this client attached to it. */
const HELD = snapshot([user, reply], "idle", 7);

/** The tail a restored process comes back with: the rows the fold emitted it for these turns. */
const held = (...sources: ReadonlyArray<PiTranscriptItem>) => sources.flatMap(itemsOf);

const stub = Effect.gen(function* () {
	const pushes = yield* Queue.unbounded<SessionSnapshot>();
	const api: PiClientApi = {
		connect: Effect.void,
		reconnect: Effect.void,
		connected: Effect.succeed(true),
		createSession: () => Effect.succeed(SESSION),
		attachSession: () => Effect.succeed(SESSION),
		heldSnapshot: () => Effect.succeed(HELD),
		prompt: () => Effect.never,
		abort: () => Effect.never,
		setModel: () => Effect.never,
		setThinkingLevel: () => Effect.never,
		models: Effect.succeed([]),
		snapshots: () => Stream.fromQueue(pushes),
		disconnections: Stream.never,
	};
	return {
		layer: Layer.succeed(PiClientService, api),
		push: (value: SessionSnapshot) => Queue.offer(pushes, value),
	};
});

type Events = Queue.Dequeue<AgentEvent, TransportError | Cause.Done>;

/** Every event the stream holds now, drained until it goes quiet. */
const drain = (events: Events) =>
	Effect.gen(function* () {
		const seen: Array<AgentEvent> = [];
		while (true) {
			const next = yield* Queue.take(events).pipe(Effect.orDie, Effect.timeoutOption("250 millis"));
			if (Option.isNone(next)) return seen;
			seen.push(next.value);
		}
	});

const itemIds = (events: ReadonlyArray<AgentEvent>): ReadonlyArray<string> =>
	events.flatMap((event) => (event.kind === "item" ? [event.item.id] : []));

const usages = (events: ReadonlyArray<AgentEvent>): number =>
	events.filter((event) => event.kind === "usage").length;

/** The tool row the agent was still running when the process went away. */
const running: PiTranscriptItem = {
	id: "item-2",
	role: "tool",
	toolCallId: "call-1",
	toolName: "read_file",
	input: {path: "README.md"},
	content: [],
	timestamp: 12,
	status: "running",
	isError: false,
};

/** A session whose ledger already holds what `reply` cost, as a checkpoint would carry it. */
const counted = (items: ReadonlyArray<TranscriptItem>, phase: Phase): AiAgentSessionState => ({
	...initialState(CWD),
	phase,
	transcript: {items: [...items], omitted: {items: 0, bytes: 0, reason: "none"}},
	usage: {
		model: `${SESSION.model.provider}/${SESSION.model.id}`,
		turns: {[reply.id]: {inputTokens: 11, outputTokens: 22, cost: 0.42}},
	},
});

/** What the session has spent once every event of this push has been folded into it. */
const spent = (state: AiAgentSessionState, events: ReadonlyArray<AgentEvent>) =>
	usageTotals(events.reduce((carried, event) => foldEvent(carried, event, {}), state).usage);

describe("a Pi session resumed by a caller that already holds its transcript", () => {
	it.live(
		"emits no item and no usage when the first push carries the transcript it opened on",
		() =>
			Effect.gen(function* () {
				const client = yield* stub;

				yield* Effect.gen(function* () {
					const agent = yield* TuvalAiAgent;
					yield* agent.start({
						cwd: CWD,
						resume: {sessionId: SESSION.id, holdsTranscript: true, held: held(user, reply)},
					});
					const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
					yield* drain(events);

					yield* client.push(HELD);
					const folded = yield* drain(events);
					assert.deepStrictEqual(itemIds(folded), [], "the resume replayed the transcript");
					assert.strictEqual(usages(folded), 0, "the resume re-added the session's usage");
				}).pipe(
					Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))),
					Effect.scoped,
				);
			}),
	);

	it.live("emits the operator's own turn, and nothing under it, on the push that carries it", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({
					cwd: CWD,
					resume: {sessionId: SESSION.id, holdsTranscript: true, held: held(user, reply)},
				});
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* drain(events);

				yield* client.push(snapshot([user, reply, sent], "turn", 8));
				const folded = yield* drain(events);
				assert.deepStrictEqual(
					itemIds(folded),
					[sent.id],
					"the send arrived under a replay of the history above it",
				);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);

	it.live("paints the history at the attach for a caller that holds none", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* agent.start({
					cwd: CWD,
					resume: {sessionId: SESSION.id, holdsTranscript: false},
				});
				const opened = yield* drain(events);
				assert.deepStrictEqual(
					itemIds(opened),
					[user.id, reply.id],
					"a window opened on a past session came up empty",
				);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);

	/**
	 * Criterion 7's own case. The picker's window is empty, so the history paints — but at the
	 * attach, before the operator can have typed anything. By the time their turn provokes Pi's
	 * first push, the fold already holds that history and emits their turn alone, so it stays the
	 * newest item in the tail instead of sitting above the session it belongs under (#8369).
	 */
	it.live("emits only the operator's turn on the first push after a picker open", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* agent.start({
					cwd: CWD,
					resume: {sessionId: SESSION.id, holdsTranscript: false},
				});
				yield* drain(events);

				yield* client.push(snapshot([user, reply, sent], "turn", 8));
				const folded = yield* drain(events);
				assert.deepStrictEqual(
					itemIds(folded),
					[sent.id],
					"the picker's first send arrived under a replay of the history above it",
				);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);

	it.live("emits the turn the session finished while the socket was down", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				// The checkpointed tail stops at the operator's turn: the reply landed after the
				// socket dropped, so this process has never seen it and nothing else will show it.
				yield* agent.start({
					cwd: CWD,
					resume: {sessionId: SESSION.id, holdsTranscript: true, held: held(user)},
				});
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* drain(events);

				yield* client.push(HELD);
				const folded = yield* drain(events);
				assert.deepStrictEqual(
					itemIds(folded),
					[reply.id],
					"the reply that landed during the drop was suppressed and never paints",
				);
				assert.strictEqual(usages(folded), 1, "the reply arrived without its own cost");
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);

	/**
	 * The drop can catch the agent mid-sentence. Pi's assistant item carries a `status: "streaming"`
	 * variant whose `usage` is optional (`../wire/transcript.ts`),
	 * so the tail this process comes back with holds a half-written reply under the same id the
	 * finished one now has. That id being the newest thing it holds does not make the finished reply
	 * read: suppressing it leaves the operator on the half-written text for the life of the session
	 * and drops the turn's cost out of the totals, with nothing to show either happened.
	 */
	it.live(
		"emits a reply that settled under the caller's own boundary while the socket was down",
		() =>
			Effect.gen(function* () {
				const client = yield* stub;

				yield* Effect.gen(function* () {
					const agent = yield* TuvalAiAgent;
					const streaming: PiTranscriptItem = {
						id: reply.id,
						role: "assistant",
						content: [{type: "text", text: "hel"}],
						model: SESSION.model,
						timestamp: 11,
						status: "streaming",
					};
					yield* agent.start({
						cwd: CWD,
						resume: {sessionId: SESSION.id, holdsTranscript: true, held: held(user, streaming)},
					});
					const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
					yield* drain(events);

					yield* client.push(HELD);
					const folded = yield* drain(events);
					assert.deepStrictEqual(
						itemIds(folded),
						[reply.id],
						"the operator is still looking at the half-written reply",
					);
					assert.strictEqual(usages(folded), 1, "the settled turn's cost never joined the totals");
				}).pipe(
					Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))),
					Effect.scoped,
				);
			}),
	);

	/**
	 * Criterion 5, the direction a seed can lose: a resume that shows the operator nothing new must
	 * cost them nothing new either.
	 */
	it.live("leaves the totals where they were when the resume adds no item", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				const tail = held(user, reply);
				yield* agent.start({
					cwd: CWD,
					resume: {sessionId: SESSION.id, holdsTranscript: true, held: tail},
				});
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* drain(events);

				yield* client.push(HELD);
				const folded = yield* drain(events);
				assert.strictEqual(
					spent(counted(tail, "ready"), folded).cost,
					0.42,
					"the resume charged the session again for a turn it had already counted",
				);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);

	/**
	 * Criterion 5, the other direction, and the ordinary shape of an agent parked mid-work: a
	 * multi-step turn checkpointed on a running tool row at phase `prompting`.
	 *
	 * `restore` marks the tail's newest assistant row `interrupted`, walking back past the tool row
	 * to reach it (`core/state.ts`) — so the reply this process already paid for comes back
	 * carrying a marker the backend's copy does not have, and the reconnect hands that marked tail
	 * through as the fold's seed. The turn is behind the seed's boundary and still differs from the
	 * snapshot, so its cost is re-reported; keying the cost on the turn is what makes the second
	 * report cost nothing (#8369).
	 */
	it.live("counts a turn parked under an interrupted marker exactly once", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				const parked = counted(held(user, reply, running), "prompting");
				const marked = restore(parked).transcript.items;
				assert.ok(
					marked.some((item) => item.kind === "assistant" && item.interrupted === true),
					"the restore left the parked reply unmarked, so this pins nothing",
				);
				yield* agent.start({
					cwd: CWD,
					resume: {sessionId: SESSION.id, holdsTranscript: true, held: marked},
				});
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* drain(events);

				yield* client.push(snapshot([user, reply, running], "turn", 8));
				const folded = yield* drain(events);
				assert.strictEqual(spent(parked, folded).cost, 0.42, "the parked turn's cost landed twice");
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);

	it.live("opens a fresh session on an empty projection, so its first snapshot paints", () =>
		Effect.gen(function* () {
			const client = yield* stub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* drain(events);

				yield* client.push(snapshot([user], "turn", 1));
				const folded = yield* drain(events);
				assert.deepStrictEqual(
					itemIds(folded),
					[user.id],
					"a fresh session's first item was eaten",
				);
			}).pipe(Effect.provide(aiAgentOverClient().pipe(Layer.provide(client.layer))), Effect.scoped);
		}),
	);
});
