/**
 * The transcript half of the fold, over a turn that outgrows the bounds while it is still open.
 *
 * `foldItem` re-plans over `transcript.items` rather than over full history, so whatever a plan
 * leaves out is gone from state and reachable only by paging (#8031). That makes an empty accepted
 * plan unrecoverable, and this file is where that stays proven.
 */

import {describe, expect, it} from "vitest";
import {
	assistantItem,
	compactionItem,
	nestedUnder,
	subagentSlot,
	systemItem,
	thinkingItem,
	toolItem,
	userItem,
} from "../../ai-agent-fixtures/transcripts.ts";
import {Mode, type ModelRef, type TranscriptItem, type TranscriptPayload} from "../ports/index.ts";
import {INTERRUPT_ERROR, PROMPT_ERROR, START_ERROR} from "./failures.ts";
import {foldEvent, foldItem, upsertItem, type WindowLimits} from "./fold.ts";
import type {SendOutcome} from "./sends.ts";
import {type AiAgentSessionState, initialState} from "./state.ts";

const empty: TranscriptPayload = {items: [], omitted: {items: 0, bytes: 0, reason: "none"}};

/** Fold a stream item by item, answering the transcript after each one. */
const foldAll = (
	start: TranscriptPayload,
	stream: ReadonlyArray<TranscriptItem>,
	limits: WindowLimits,
): ReadonlyArray<TranscriptPayload> => {
	const steps: Array<TranscriptPayload> = [];
	let transcript = start;
	for (const item of stream) {
		transcript = foldItem(transcript, item, limits);
		steps.push(transcript);
	}
	return steps;
};

/**
 * The window bounds are spent on what the desk renders, so a spawn cannot shave the visible head.
 *
 * A worker's rows arrive as ordinary items tagged with the call they ran inside, and `chatRows`
 * drops every one of them; before #8814 they paid full window freight on the way past, so a few
 * spawns pushed the operator's own turns out of a tail that then rendered nothing at all.
 */
describe("folding turns that spawn subagents", () => {
	const SPAWNS = 6;
	const ROWS_PER_WORKER = 12;

	/** `SPAWNS` operator exchanges, each ending in a call whose worker rows arrive tagged. */
	const withSpawns = (workerOutput = "ok"): ReadonlyArray<TranscriptItem> =>
		Array.from({length: SPAWNS}).flatMap((_spawnSlot, spawn) => {
			const call = `spawn-${spawn}`;
			const worker = Array.from({length: ROWS_PER_WORKER}).flatMap((_workerSlot, index) => [
				systemItem(`worker-notice-${spawn}-${index}`),
				assistantItem(`worker-reply-${spawn}-${index}`),
				toolItem(`worker-tool-${spawn}-${index}`, workerOutput),
			]);
			return [
				userItem(`u${spawn}`),
				assistantItem(`a${spawn}`),
				toolItem(call),
				...worker.map((item) => nestedUnder(item, call)),
			];
		});

	const ownIds = (items: ReadonlyArray<TranscriptItem>): ReadonlyArray<string> =>
		items.filter((item) => item.parentId === undefined).map((item) => item.id);

	it("leaves every one of the operator's own rows in the tail at itemLimit 40", () => {
		const stream = withSpawns();
		const tail = foldAll(empty, stream, {itemLimit: 40}).at(-1)?.items ?? [];
		expect(ownIds(tail)).toEqual(ownIds(stream));
	});

	it("spends no byte budget on them either", () => {
		const stream = withSpawns("x".repeat(4_000));
		const tail = foldAll(empty, stream, {itemLimit: 40, byteLimit: 20_000}).at(-1)?.items ?? [];
		expect(ownIds(tail)).toEqual(ownIds(stream));
	});
});

describe("folding a turn that outgrows the bounds", () => {
	it("never empties the tail while the open group is still growing", () => {
		const turn = [
			userItem("u1"),
			...Array.from({length: 11}, (_, index) => toolItem(`t${index}`)),
			assistantItem("a1"),
		];
		const steps = foldAll(empty, turn, {itemLimit: 5});
		expect(steps.map((step) => step.items.length)).toEqual(turn.map((_, index) => index + 1));
		expect(steps.at(-1)?.items).toEqual(turn);
		expect(steps.at(-1)?.omitted).toEqual({items: 0, bytes: 0, reason: "none"});
	});

	it("drops the exchange before it once, and keeps the growing one whole", () => {
		const older = [userItem("u0"), assistantItem("a0")];
		const turn = [userItem("u1"), ...Array.from({length: 8}, (_, index) => toolItem(`t${index}`))];
		const seeded = foldAll(empty, older, {itemLimit: 5}).at(-1) ?? empty;
		const steps = foldAll(seeded, turn, {itemLimit: 5});
		expect(steps.every((step) => step.items.length > 0)).toBe(true);
		expect(steps.at(-1)?.items).toEqual(turn);
		expect(steps.at(-1)?.omitted.items).toBe(older.length);
		expect(steps.at(-1)?.omitted.reason).toBe("item-limit");
	});
});

describe("folding a reply that is still being written", () => {
	it("supersedes a partial item with the final one under the same id", () => {
		const growing = {...assistantItem("a1", "he"), partial: true} as const;
		const finished = assistantItem("a1", "hello");
		expect(upsertItem([userItem("u1"), growing], finished)).toEqual([userItem("u1"), finished]);
	});

	it("leaves the fold one item however many partials preceded the final one", () => {
		const deltas = ["h", "he", "hel", "hell", "hello"].map((text) => ({
			...assistantItem("a1", text),
			partial: true,
		}));
		const tail = foldAll(empty, [...deltas, assistantItem("a1", "hello")], {itemLimit: 5}).at(-1);
		expect(tail?.items).toEqual([assistantItem("a1", "hello")]);
		expect(tail?.omitted).toEqual({items: 0, bytes: 0, reason: "none"});
	});
});

describe("folding the thinking and compaction kinds", () => {
	it("supersedes a thinking row by id, so a growing one stays one row", () => {
		const first = thinkingItem("k1", "weighing the two reads");
		const grown = thinkingItem("k1", "weighing the two reads, then the write");
		expect(upsertItem(upsertItem([userItem("u1")], first), grown)).toEqual([userItem("u1"), grown]);
	});

	it("appends a compaction marker under a fresh id rather than replacing a neighbour", () => {
		const marker = compactionItem("c1");
		expect(upsertItem([userItem("u1"), assistantItem("a1")], marker)).toEqual([
			userItem("u1"),
			assistantItem("a1"),
			marker,
		]);
	});

	// `echoOf` is confined to `user` items, so a reasoning row repeating the prompt's own words
	// cannot be taken for the layer's echo of that prompt and overwrite it.
	it("never joins a thinking row onto a locally-recorded turn of the same text", () => {
		const local: TranscriptItem = {...userItem("u1", "run the tests"), local: true};
		const echoing = thinkingItem("k1", "run the tests");
		expect(upsertItem([local], echoing)).toEqual([local, echoing]);
	});

	it("bounds the tail over the new kinds, cutting at the compaction marker's own edge", () => {
		const stream = [
			systemItem("s0"),
			compactionItem("c0"),
			userItem("u1"),
			thinkingItem("k1"),
			assistantItem("a1"),
		];
		const bounded = foldAll(empty, stream, {itemLimit: 4}).at(-1);
		expect(bounded?.items).toEqual(stream.slice(1));
		expect(bounded?.omitted.items).toBe(1);
		expect(bounded?.omitted.reason).toBe("item-limit");
	});

	it("keeps a thinking row inside its turn, so the bound drops the marker before it", () => {
		const stream = [compactionItem("c0"), userItem("u1"), thinkingItem("k1"), assistantItem("a1")];
		const bounded = foldAll(empty, stream, {itemLimit: 3}).at(-1);
		expect(bounded?.items).toEqual(stream.slice(1));
		expect(bounded?.omitted.items).toBe(1);
	});
});

describe("folding a subagent slot", () => {
	const base = initialState("/repo");
	const limits: WindowLimits = {};
	const fold = (state = base, slot = subagentSlot("call-1")) =>
		foldEvent(state, {kind: "subagent", slot}, limits);

	it("upserts by id, so a worker's hundred lines are one row", () => {
		const once = fold();
		expect(Object.keys(once.subagents)).toEqual(["call-1"]);

		const twice = fold(
			once,
			subagentSlot("call-1", {lastLine: "writing the patch", tokens: 9_000}),
		);
		expect(Object.keys(twice.subagents)).toEqual(["call-1"]);
		expect(twice.subagents["call-1"]?.lastLine).toBe("writing the patch");
		expect(twice.subagents["call-1"]?.tokens).toBe(9_000);
	});

	it("keeps a second worker beside the first rather than replacing it", () => {
		const both = fold(fold(), subagentSlot("call-2", {type: "reviewer"}));
		expect(Object.keys(both.subagents).sort()).toEqual(["call-1", "call-2"]);
		expect(both.subagents["call-2"]?.type).toBe("reviewer");
	});

	// Q9: a view open on a finished worker still has its rows, so finishing is a status and never a
	// removal.
	it("marks a worker finished without dropping it or its rows", () => {
		const items = [userItem("u1"), assistantItem("a1")];
		const running = fold(base, subagentSlot("call-1", {items}));
		const done = fold(running, subagentSlot("call-1", {items, status: "finished"}));
		expect(done.subagents["call-1"]?.status).toBe("finished");
		expect(done.subagents["call-1"]?.items).toEqual(items);
	});

	// A worker runs inside its parent's turn, so the turn's end settles it — a slot the layer never
	// closed would otherwise hold the checkpoint gate shut for the rest of the session.
	it("settles a worker the layer left running when the turn ends", () => {
		const running = fold();
		const ready = foldEvent(running, {kind: "phase", phase: "ready"}, limits);
		expect(ready.subagents["call-1"]?.status).toBe("finished");

		const failed = foldEvent(
			running,
			{kind: "failure", failure: {tag: "PromptError", reason: null, detail: "the stream died"}},
			limits,
		);
		expect(failed.subagents["call-1"]?.status).toBe("finished");
	});

	it("leaves a worker running while the turn it belongs to is still going", () => {
		const running = foldEvent(fold(), {kind: "phase", phase: "prompting"}, limits);
		expect(running.subagents["call-1"]?.status).toBe("running");
	});
});

/**
 * #8236's ruling, at the arms rather than at the ledger: a per-turn failure leaves the session
 * alive, so it settles only the send it is about, and `gone` is the terminal arm that settles every
 * one of them.
 */
describe("folding a failure and a `gone` under two sends in flight", () => {
	const limits: WindowLimits = {};
	const refusal = {tag: PROMPT_ERROR, reason: "refused", detail: "the layer refused the handoff"};
	const inFlight: ReadonlyArray<SendOutcome> = [
		{key: "first", state: "pending", turn: "running"},
		{key: "second", state: "pending", turn: "unstarted"},
	];
	const prompting: AiAgentSessionState = {
		...initialState("/repo"),
		phase: "prompting",
		sends: inFlight,
	};

	it("settles only the failed send and keeps the other waiting for its own turn", () => {
		const failed = foldEvent(prompting, {kind: "failure", failure: refusal}, limits);
		expect(failed.phase).toBe("ready");
		expect(failed.sends).toEqual([
			{key: "first", state: "refused", failure: refusal},
			{key: "second", state: "pending", turn: "unstarted"},
		]);
	});

	it("accepts the send that outlived the refusal when its own turn ends", () => {
		const failed = foldEvent(prompting, {kind: "failure", failure: refusal}, limits);
		const running = foldEvent(failed, {kind: "phase", phase: "prompting"}, limits);
		const ended = foldEvent(running, {kind: "phase", phase: "ready"}, limits);
		expect(ended.sends).toEqual([
			{key: "first", state: "refused", failure: refusal},
			{key: "second", state: "accepted"},
		]);
	});

	it("settles every send in flight when the session goes", () => {
		const gone = foldEvent(prompting, {kind: "phase", phase: "gone"}, limits);
		expect(gone.sends).toEqual([
			{key: "first", state: "uncertain", failure: null},
			{key: "second", state: "uncertain", failure: null},
		]);
	});
});

/**
 * ADR 0356's two halves. The tag is routed before `phaseAfterFailure`, so neither of these is the
 * walk-to-`ready` every other failure gets — one of them stays put, and the other lands there for a
 * different reason and marks the turn on the way.
 */
describe("folding a refused interrupt", () => {
	const limits: WindowLimits = {};
	const refusal = (reason: string, detail: string) => ({tag: INTERRUPT_ERROR, reason, detail});
	const reply = assistantItem("a1");
	const prompting: AiAgentSessionState = {
		...initialState("/repo"),
		phase: "prompting",
		transcript: {items: [reply], omitted: {items: 0, bytes: 0, reason: "none"}},
		interruption: {requestedAt: 1_700_000_000_000},
		sends: [{key: "first", state: "pending", turn: "running"}],
	};

	it("leaves the phase at prompting when the turn is still running", () => {
		const failure = refusal("turn-running", "the CLI would not take the control request");
		const refused = foldEvent(prompting, {kind: "failure", failure}, limits);
		expect(refused.phase).toBe("prompting");
		expect(refused.failure).toEqual(failure);
		expect(refused.interruption).toEqual(prompting.interruption);
		expect(refused.interrupted).toBeNull();
	});

	// The turn goes on, so the send it is about goes on too: this failure names the interrupt call
	// and nothing the operator sent.
	it("leaves the send in flight alone while the turn runs", () => {
		const failure = refusal("turn-running", "the CLI would not take the control request");
		const refused = foldEvent(prompting, {kind: "failure", failure}, limits);
		expect(refused.sends).toEqual(prompting.sends);
	});

	// The 2026-09-05 19:09 PT freeze: "interrupt was refused: Operation aborted" left the desk at
	// `prompting` until a restart, because every failure walked one phase and this one walked none.
	it("ends the turn and readies the session when there was no live turn", () => {
		const failure = refusal("no-live-turn", "Operation aborted");
		const refused = foldEvent(prompting, {kind: "failure", failure}, limits);
		expect(refused.phase).toBe("ready");
		expect(refused.interrupted).toBe(reply.id);
		expect(refused.interruption).toBeNull();
		expect(refused.failure).toEqual(failure);
	});

	// The half that walks to `ready` is the half whose turn already ended, so it owes that turn's
	// send the acceptance the `phase` arm's own walk to `ready` performs. Nothing else will: the
	// end was never narrated, so no later event reaches this send.
	it("accepts the send whose turn had already ended when there was no live turn", () => {
		const failure = refusal("no-live-turn", "Operation aborted");
		const refused = foldEvent(prompting, {kind: "failure", failure}, limits);
		expect(refused.sends).toEqual([{key: "first", state: "accepted"}]);
	});

	it("changes no phase when the session was not on a turn at all", () => {
		const idle: AiAgentSessionState = {...initialState("/repo"), phase: "ready"};
		const failure = refusal("no-live-turn", "Operation aborted");
		const refused = foldEvent(idle, {kind: "failure", failure}, limits);
		expect(refused.phase).toBe("ready");
		expect(refused.failure).toEqual(failure);
	});
});

describe("folding the version a layer reports", () => {
	const limits: WindowLimits = {};

	it("fills the slot the state starts empty", () => {
		const start = initialState("/repo");
		expect(start.agentVersion).toBeNull();
		expect(foldEvent(start, {kind: "version", version: "2.1.259"}, limits).agentVersion).toBe(
			"2.1.259",
		);
	});

	// A layer re-announces on every open, and a resume walks a stream that has already announced —
	// so the newest report has to win rather than accumulate beside the one before it.
	it("replaces what it held, so a re-announced session reads as what it runs now", () => {
		const first = foldEvent(initialState("/repo"), {kind: "version", version: "2.1.259"}, limits);
		expect(foldEvent(first, {kind: "version", version: "2.2.0"}, limits).agentVersion).toBe(
			"2.2.0",
		);
	});

	it("touches nothing else on the session", () => {
		const start: AiAgentSessionState = {...initialState("/repo"), phase: "prompting"};
		const folded = foldEvent(start, {kind: "version", version: "2.1.259"}, limits);
		expect({...folded, agentVersion: null}).toEqual(start);
	});
});

describe("folding the account a layer reports", () => {
	const limits: WindowLimits = {};
	const account = {organization: "kamp.us", subscriptionType: "max"};

	it("fills the slot the state starts empty", () => {
		const start = initialState("/repo");
		expect(start.account).toBeNull();
		expect(foldEvent(start, {kind: "account", account}, limits).account).toEqual(account);
	});

	// Each field stands alone: an API-key login reports a plan and no organization, and neither is
	// a state the slot has to represent with a placeholder.
	it("keeps a report that carries only one of the two fields", () => {
		const folded = foldEvent(initialState("/repo"), {kind: "account", account: {}}, limits);
		expect(folded.account).toEqual({});
		expect(
			foldEvent(
				initialState("/repo"),
				{kind: "account", account: {subscriptionType: "max"}},
				limits,
			).account,
		).toEqual({subscriptionType: "max"});
	});

	// Replaced whole rather than merged: a field the newest announcement omits is a field this
	// session does not have, and keeping the previous login's organization beside it would lie.
	it("replaces what it held rather than merging into it", () => {
		const first = foldEvent(initialState("/repo"), {kind: "account", account}, limits);
		expect(
			foldEvent(first, {kind: "account", account: {subscriptionType: "pro"}}, limits).account,
		).toEqual({subscriptionType: "pro"});
	});

	it("touches nothing else on the session", () => {
		const start: AiAgentSessionState = {...initialState("/repo"), phase: "prompting"};
		const folded = foldEvent(start, {kind: "account", account}, limits);
		expect({...folded, account: null}).toEqual(start);
	});
});

/**
 * #8634: the catalogs belong to the session they were read off, so both routes to `gone` end them.
 * The layer's own teardown clear reaches only a session torn down in this process, and these two
 * are the lifetimes it does not reach.
 */
describe("folding a session's end over its catalogs", () => {
	const limits: WindowLimits = {};
	const opus: ModelRef = {provider: "anthropic", id: "claude-opus-5", name: "Opus 5"};
	const sonnet: ModelRef = {provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet 5"};
	const offering: AiAgentSessionState = {
		...initialState("/repo"),
		phase: "ready",
		modes: {current: Mode.make("plan"), available: [Mode.make("plan"), Mode.make("build")]},
		models: {current: opus, available: [opus, sonnet]},
		commands: [{name: "compact", description: "Summarise the conversation."}],
		thinking: {current: "medium", available: ["low", "medium", "high"]},
	};

	const empties = (state: AiAgentSessionState) => {
		expect(state.models.available).toEqual([]);
		expect(state.thinking.available).toEqual([]);
		expect(state.modes.available).toEqual([]);
		expect(state.commands).toEqual([]);
	};

	// The pick is the operator's, not the session's, and the next open re-validates it (#7981).
	const keepsThePicks = (state: AiAgentSessionState) => {
		expect(state.models.current).toEqual(opus);
		expect(state.thinking.current).toBe("medium");
		expect(state.modes.current).toBe(Mode.make("plan"));
	};

	it("empties every offered catalog on the phase a layer narrates", () => {
		const gone = foldEvent(offering, {kind: "phase", phase: "gone"}, limits);
		expect(gone.phase).toBe("gone");
		empties(gone);
		keepsThePicks(gone);
	});

	// The rebuilt layer's route: the resume names a session the backend no longer holds, so no
	// `start` ran and nothing announced the clear.
	it("empties them on a refused resume folded from reconnecting", () => {
		const reconnecting: AiAgentSessionState = {...offering, phase: "reconnecting"};
		const failure = {
			tag: START_ERROR,
			reason: "session-not-found",
			detail: "the backend does not hold session-1",
		};
		const gone = foldEvent(reconnecting, {kind: "failure", failure}, limits);
		expect(gone.phase).toBe("gone");
		empties(gone);
		keepsThePicks(gone);
	});

	// A reconnect that fails on anything else is a transport worth retrying, so its catalogs are
	// still the ones this session will re-announce.
	it("leaves them alone on a reconnect failure that lands back on idle", () => {
		const reconnecting: AiAgentSessionState = {...offering, phase: "reconnecting"};
		const failure = {tag: START_ERROR, reason: null, detail: "the socket closed"};
		const idle = foldEvent(reconnecting, {kind: "failure", failure}, limits);
		expect(idle.phase).toBe("idle");
		expect(idle.models.available).toEqual([opus, sonnet]);
		expect(idle.thinking.available).toEqual(["low", "medium", "high"]);
		expect(idle.modes.available).toHaveLength(2);
		expect(idle.commands).toHaveLength(1);
	});
});
