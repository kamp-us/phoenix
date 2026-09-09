/**
 * The per-turn `result` a `TuvalAiAgent` layer owes, derived from the events it already emits.
 *
 * A layer narrates a turn's end as a phase and nothing more, so what the turn *answered* is
 * knowable only to whoever folded the whole turn. `withTurnResult` is that fold, applied to a
 * layer's own `events` stream: it watches the `prompting` … turn-end bracket the phase contract
 * already requires ([`.patterns/agent-layer-phase-contract.md`](../../../../.patterns/agent-layer-phase-contract.md)),
 * collects the turn's items as they arrive, and emits one `ResultEvent` immediately ahead of the
 * event that closes the turn.
 *
 * One shared fold rather than five: the obligation is per layer, but the bookkeeping behind it is
 * identical everywhere and the phase contract's own history is two layers getting exactly this kind
 * of per-turn promise wrong (#7963, #7897). Each layer still pays it — the wrap is on its own
 * `events` member, and a layer that drops it emits no result and reds in its own test.
 *
 * A layer that knows its backend's answer better than this fold can derive it may emit its own
 * `result` inside the turn; the fold then adds none, so the two can never both land.
 */

import {Stream} from "effect";
import {INTERRUPT_ERROR} from "./core/failures.ts";
import type {AgentEvent, AgentFailure, Phase} from "./events.ts";
import type {AssistantItem, TranscriptItem, TurnResult} from "./ports/index.ts";

/** A turn the bracket has opened and nothing has closed yet. `null` is "between turns". */
export interface RunningTurn {
	readonly items: ReadonlyArray<TranscriptItem>;
	/** Nothing has refused this turn so far. */
	readonly ok: boolean;
	/** The layer emitted its own result for this turn, so the fold owes none. */
	readonly answered: boolean;
}

export type TurnTracking = RunningTurn | null;

export const betweenTurns: TurnTracking = null;

const started: RunningTurn = {items: [], ok: true, answered: false};

/** An item with a known id supersedes the one it names; the fold in `core/fold.ts` does the same. */
const upsert = (
	items: ReadonlyArray<TranscriptItem>,
	item: TranscriptItem,
): ReadonlyArray<TranscriptItem> => {
	const at = items.findIndex((candidate) => candidate.id === item.id);
	return at < 0
		? [...items, item]
		: items.map((candidate, index) => (index === at ? item : candidate));
};

/**
 * The streaming marker off a row the turn ended on. A turn that errored or was cut never gets the
 * settling upsert that would have dropped it (`core/state.ts`, `settlePartialItems`), and a
 * finished turn's payload carrying a row still marked "being written" is a lie a consumer cannot
 * check.
 */
const settled = (item: TranscriptItem): TranscriptItem => {
	if (!("partial" in item) || item.partial !== true) return item;
	const {partial: _written, ...rest} = item;
	return rest;
};

/** The line a consumer would quote: the newest assistant row's text, or nothing said. */
const textOf = (items: ReadonlyArray<TranscriptItem>): string =>
	items.findLast((item): item is AssistantItem => item.kind === "assistant")?.text ?? "";

export const turnResult = (turn: RunningTurn, ok: boolean): TurnResult => {
	const items = turn.items.map(settled);
	return {text: textOf(items), items, ok: turn.ok && ok};
};

/**
 * Does this refusal end the turn on its own?
 *
 * Only the refused interrupt does, and only away from `turn-running` — that is the one case where
 * the backend says there is nothing left to stop, and `foldInterruptRefusal` (`core/fold.ts`) walks
 * the session to `ready` off it with no phase event to follow. Mirrored here so the turn it closes
 * still gets its one result; `turn-running` closes nothing, and is not even a mark against the turn,
 * because it names the interrupt call rather than the turn.
 */
const endsTheTurn = (failure: AgentFailure): boolean =>
	failure.tag === INTERRUPT_ERROR && failure.reason !== "turn-running";

/** The phases that close a turn a layer opened. `starting`/`reconnecting` are the core's own. */
const closesTheTurn = (phase: Phase): boolean => phase === "ready" || phase === "gone";

/**
 * One event in, the events out — the input, with this turn's result ahead of it when the input is
 * what closed the turn.
 *
 * Ahead rather than behind, because `session-reset` is a turn's end and a conversation swap in one
 * event: after it the core's session id is the new conversation's, and a result pushed under the
 * old one is dropped by the machine's identity filter (`core/messages.ts`).
 */
export const trackTurn = (
	turn: TurnTracking,
	event: AgentEvent,
): readonly [TurnTracking, ReadonlyArray<AgentEvent>] => {
	const close = (ok: boolean): readonly [TurnTracking, ReadonlyArray<AgentEvent>] =>
		turn === null || turn.answered
			? [null, [event]]
			: [null, [{kind: "result", result: turnResult(turn, ok)}, event]];

	switch (event.kind) {
		case "phase":
			if (event.phase === "prompting") return [started, [event]];
			if (closesTheTurn(event.phase)) return close(event.phase === "ready");
			return [turn, [event]];
		case "session-reset":
			return close(true);
		case "item":
			if (turn === null) return [null, [event]];
			return [
				{
					...turn,
					items: upsert(turn.items, event.item),
					// A reply the backend marked cut short is a turn nobody should read as clean,
					// and it is the one interruption that reaches this fold as data: the operator's
					// abort itself rides no event, and the turn still ends on an ordinary `ready`.
					ok: turn.ok && !(event.item.kind === "assistant" && event.item.interrupted === true),
				},
				[event],
			];
		case "failure":
			if (turn === null) return [null, [event]];
			if (endsTheTurn(event.failure)) return close(false);
			return [event.failure.reason === "turn-running" ? turn : {...turn, ok: false}, [event]];
		case "result":
			return [turn === null ? null : {...turn, answered: true}, [event]];
		default:
			return [turn, [event]];
	}
};

/**
 * A layer's event stream with its per-turn `result` in it. Every `TuvalAiAgent` layer wraps its own
 * `events` member in this — that wrap is how the layer pays the obligation.
 */
export const withTurnResult = <E, R>(
	events: Stream.Stream<AgentEvent, E, R>,
): Stream.Stream<AgentEvent, E, R> => Stream.mapAccum(events, () => betweenTurns, trackTurn);
