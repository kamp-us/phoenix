/**
 * agy's NDJSON stream → the `AgentEvent`s the core folds. Pure, total, and the far side of this
 * module is `ai-agent/events.ts` + `ai-agent/ports/` only: no agy wire type crosses.
 *
 * A line is folded against a small carry (`AgyTurn`) rather than read alone, because three facts
 * about the wire need memory:
 *
 * - **`text_delta` is incremental**, and the `DONE` step carries the last chunk, not the
 *   accumulation. So the turn's reply is streamed into one assistant item whose text grows, and
 *   the terminal `result` re-sends *that same `ItemId`* with `result.response`, which is the only
 *   place the whole reply lives. The deltas are lossy against it: a captured turn's steps read
 *   `" delegated the research task…"` where the response reads `"I have delegated…"`.
 * - **`init.model` names the model** and only `init` carries it, while every usage payload that
 *   needs the name arrives later.
 * - **`result.usage` is the *conversation's* running total, not the turn's.** A three-turn census of
 *   agy v1.1.28 (the third turn run on a resumed child) reads `16771/1`, `21419/2`, `26280/3` in
 *   `result.usage.input_tokens`/`output_tokens` while the three turns' own `agent_response` steps
 *   report `16771/1`, `4648/1`, `4861/1` — field by field the result is the sum of every step in the
 *   *conversation*, so it restates what earlier turns already spent. The core's `addUsage` folds
 *   usage by plain addition, so a `result` reported as this turn's own total double-counts every
 *   earlier turn ([#8695](https://github.com/kamp-us/phoenix/issues/8695)): the turn is the
 *   cumulative's increment over the last cumulative this child read, and `result.num_turns` is what
 *   says whether there is an earlier one inside it at all — or, when agy sent no `num_turns`, what
 *   cannot say, which is why that unknown takes the same arm a resumed child does
 *   ([#8707](https://github.com/kamp-us/phoenix/issues/8707)).
 * - A row with no natural wire key (an unreadable line, a denied-action report) needs an id that
 *   does not collide with the next one.
 *
 * A tool call and its outcome both ride inside `step_update` — `DONE` carries `tool_info.output`,
 * `ERROR` carries `tool_info.error` — so both project onto one `ToolItem` keyed by
 * `<conversation_id>:<step_index>`, and the running row is superseded rather than duplicated.
 * A subagent invocation projects onto the same shape, and its `DONE` payload adds only
 * `duration_seconds` to its `ACTIVE` one — the `subagent_info` payload is byte-identical and
 * carries no result — so `state` alone drives the transition.
 *
 * **A turn the operator stopped is marked, not failed.** `SIGINT` lands a terminal `result` reading
 * `status: "ERROR"` / `error: "interrupted"` — measured, and the whole point of
 * [#8694](https://github.com/kamp-us/phoenix/issues/8694) — so this wire does name the stop. It
 * projects onto the cut reply row carrying `interrupted: true` and no `failure` event at all, which
 * is the mark `pi/ai-agent/items.ts` makes of an `aborted` item and `codex/history.ts` of an
 * `interrupted` turn. A row is minted even when the reply had no text yet, for the reason Pi keeps an
 * empty aborted reply: the mark needs a row to sit on.
 *
 * **An unrecognised `step_type` renders a `SystemItem` and is never dropped and never thrown on.**
 * That is the whole reason this file has a default arm: the enum is provably open and the stream
 * carries no version to branch on (see `wire.ts`).
 */

import type {AgentEvent} from "../../ai-agent/events.ts";
import type {ItemId, JsonValue, ToolStatus} from "../../ai-agent/ports/index.ts";
import {
	assistantItem,
	interruptedItem,
	itemId,
	systemItem,
	toolItem,
	toolStatusOf,
	userItem,
} from "./items.ts";
import {
	type AgyResult,
	type AgyStepUpdate,
	type AgySubagentInfo,
	type AgyUsage,
	decodeLine,
} from "./wire.ts";

type UsageEvent = Extract<AgentEvent, {readonly kind: "usage"}>;

export {itemId} from "./items.ts";

/** How much of an unreadable line reaches the transcript before it is cut. */
export const UNREADABLE_LINE_LIMIT = 500;

/**
 * What `result.error` reads when the turn ended because `SIGINT` landed.
 *
 * Measured, twice and independently: a scratch desk against v1.1.27
 * ([#8694](https://github.com/kamp-us/phoenix/issues/8694)) and a direct `SIGINT` probe against
 * v1.1.28, both of which answered `{"status":"ERROR","response":"","error":"interrupted"}` and exit
 * 1. ADR 0362 originally recorded `"timeout waiting for response"` here and has been corrected.
 */
export const AGY_INTERRUPTED_ERROR = "interrupted";

/**
 * Read off the wire rather than off the layer's memory of having sent the signal, which is what
 * #8694 buys: the wire names the stop, so the mapper stays pure and a stop agy took on its own
 * account reads the same as one this process asked for — which is the truth either way.
 */
const wasInterrupted = (result: AgyResult): boolean =>
	result.status !== "SUCCESS" && result.error?.trim().toLowerCase() === AGY_INTERRUPTED_ERROR;

/** A pair of token counts, which is all of `AgyUsage` the port has a field for. */
interface Tokens {
	readonly inputTokens: number;
	readonly outputTokens: number;
}

const noTokens: Tokens = {inputTokens: 0, outputTokens: 0};

const tokensOf = (usage: AgyUsage): Tokens => ({
	inputTokens: usage.input_tokens,
	outputTokens: usage.output_tokens,
});

const minus = (total: Tokens, already: Tokens): Tokens => ({
	// Clamped: a negative increment is not a thing the ledger can hold, and a wire that ever
	// under-reports a total against its own parts must not be able to subtract spend.
	inputTokens: Math.max(0, total.inputTokens - already.inputTokens),
	outputTokens: Math.max(0, total.outputTokens - already.outputTokens),
});

const spent = (tokens: Tokens): boolean => tokens.inputTokens > 0 || tokens.outputTokens > 0;

/**
 * The ledger keys, and the reason both name agy's own identities rather than a counter this process
 * keeps.
 *
 * The core keys a cost on `UsageEvent.turn` and keeps the *first* report under a key it has seen
 * (`../../ai-agent/core/fold.ts`). A desk restore rebuilds the layer over a core state that already
 * holds this conversation's ledger, so a counter starting at `0` either aliases a key the ledger has
 * spent — dropping the restored session's tokens — or lands past it and double-counts a report agy
 * repeats ([#8695](https://github.com/kamp-us/phoenix/issues/8695)). Keyed on the conversation plus
 * the step or the turn agy itself numbers, a report lands on the entry it already wrote whatever
 * process reads it, so the dedupe does the work and the carry needs no memory across a restore —
 * which is how `pi/ai-agent/items.ts` keys usage (on the backend's own item id).
 *
 * `step_index` is numbered per conversation and continues across a resume (measured: a resumed child
 * opened at `4` on a conversation that had reached `3`), and `result.num_turns` counts that
 * conversation's turns (`1`, `2`, then `3` on the resumed child).
 */
const stepUsageKey = (conversationId: string, stepIndex: number): string =>
	`agy:usage:${conversationId}:step:${stepIndex}`;

/**
 * The result's own key. `num_turns` names the turn whenever agy sent one; when it did not, the last
 * `step_index` this turn carried is the only other identity agy itself numbered, and it is as stable
 * across a restore as the turn number is — both count the conversation, not the process. A turn that
 * carried no step at all leaves neither, and then the conversation is the whole of the key: a second
 * such turn folds onto this entry and is dropped, which is the under-reporting side `turnTokensOf`
 * already takes on an unknown turn number, not the over-charging one.
 */
const turnUsageKey = (
	conversationId: string,
	turns: number | null,
	lastStepIndex: number | null,
): string => {
	if (turns !== null) return `agy:usage:${conversationId}:turn:${turns}`;
	if (lastStepIndex !== null) return `agy:usage:${conversationId}:turn-after-step:${lastStepIndex}`;
	return `agy:usage:${conversationId}:turn:unnumbered`;
};

export interface AgyTurn {
	/** `agy/<model>` once `init` names one, else the bare binary — agy omits `init.model` on a default run. */
	readonly model: string;
	/** The item this turn's reply streams into, minted at its first `agent_response` delta. */
	readonly responseId: ItemId | null;
	readonly responseText: string;
	/** Monotonic, so two keyless rows never share an id. */
	readonly minted: number;
	/** What this turn's own steps have already reported, so the `result` reports only the residual. */
	readonly reported: Tokens;
	/**
	 * The last `step_index` this turn's steps carried, `null` before any of them has. It keys the
	 * result's usage when agy numbered no turn — see `turnUsageKey`.
	 */
	readonly lastStepIndex: number | null;
	/**
	 * The last `result.usage` this child read — the *conversation's* cumulative, against which the
	 * next `result` is an increment. `null` before this child has read one, which is the case a
	 * resumed child is in for its first turn: the cumulative it then reads contains turns this
	 * process never saw, and `result.num_turns` is what distinguishes that from a genuinely first
	 * turn whose cumulative is its own — unless it is `null`, and then nothing does.
	 */
	readonly cumulative: Tokens | null;
}

export const idleTurn: AgyTurn = {
	model: "agy",
	responseId: null,
	responseText: "",
	minted: 0,
	reported: noTokens,
	lastStepIndex: null,
	cumulative: null,
};

interface Folded {
	readonly events: ReadonlyArray<AgentEvent>;
	readonly next: AgyTurn;
}

const systemEvent = (id: string, timestamp: number, text: string): AgentEvent => ({
	kind: "item",
	item: systemItem(id, timestamp, text),
});

/**
 * agy reports no cost anywhere on the stream, so `cost` is `0` rather than a guess, and
 * `thinking_tokens` / `cache_read_tokens` have no port field and are left on the wire.
 */
const usageEvent = (model: string, key: string, tokens: Tokens): UsageEvent => ({
	kind: "usage",
	turn: key,
	model,
	inputTokens: tokens.inputTokens,
	outputTokens: tokens.outputTokens,
	cost: 0,
});

/**
 * What this turn spent, read out of a cumulative that may contain turns this child never saw.
 *
 * Four arms, and the first is the measurement: with a cumulative of its own to subtract, the turn is
 * the difference. Without one, `num_turns` decides — a first turn's cumulative *is* its own, while a
 * resumed child's first cumulative carries the whole conversation, and then the turn's own steps are
 * the only grounded measure of it. Reporting the cumulative there would charge the operator again for
 * every turn before the restore, which is the defect #8695 caught; reporting the steps under-reports
 * only a turn whose steps said nothing, and that is the smaller lie by the whole of the
 * conversation's history.
 *
 * A `num_turns` agy did not send takes the steps too, for the same reason the terminal status below
 * reads only `SUCCESS` as a success: an unknown that could be the costly case is read as the costly
 * case ([#8707](https://github.com/kamp-us/phoenix/issues/8707)).
 */
const turnTokensOf = (previous: AgyTurn, result: AgyResult): Tokens => {
	if (result.usage === undefined) return noTokens;
	const cumulative = tokensOf(result.usage);
	if (previous.cumulative !== null) return minus(cumulative, previous.cumulative);
	if (result.num_turns === null) return previous.reported;
	return result.num_turns <= 1 ? cumulative : previous.reported;
};

const subagentInput = (info: AgySubagentInfo): JsonValue => ({
	subagents: info.subagents.map((subagent) => ({
		type_name: subagent.type_name ?? null,
		role: subagent.role ?? null,
		initial_prompt: subagent.initial_prompt ?? null,
		conversation_id: subagent.conversation_id ?? null,
		log_uri: subagent.log_uri ?? null,
		workspace_uris: subagent.workspace_uris === undefined ? null : [...subagent.workspace_uris],
	})),
});

const toolResultText = (step: AgyStepUpdate, status: ToolStatus): string => {
	if (status === "error") {
		const error = step.tool_info?.error;
		if (error === undefined) return "agy reported a tool error with no detail";
		return error.type.length === 0 ? error.message : `${error.type}: ${error.message}`;
	}
	return status === "ok" ? (step.tool_info?.output ?? "") : "";
};

const unrecognisedText = (step: AgyStepUpdate): string => {
	const delta = step.text_delta;
	const head = `agy step ${step.step_index} of an unrecognised type ${JSON.stringify(step.step_type)} (${step.state})`;
	return delta === undefined || delta.length === 0 ? head : `${head}: ${delta}`;
};

const stepEvents = (previous: AgyTurn, step: AgyStepUpdate, timestamp: number): Folded => {
	const events: Array<AgentEvent> = [];
	const key = `${step.conversation_id}:${step.step_index}`;
	const delta = step.text_delta ?? "";
	let next: AgyTurn = {...previous, lastStepIndex: step.step_index};

	switch (step.step_type) {
		case "user_input":
			// v1.1.27 carries no text on this step; the core already holds the operator's own turn,
			// so an empty row here would be a blank bubble beside it rather than an echo of it.
			if (delta.length > 0) events.push({kind: "item", item: userItem(key, timestamp, delta)});
			break;

		case "agent_response":
			if (delta.length > 0) {
				const id = previous.responseId ?? itemId(key);
				const text = previous.responseText + delta;
				next = {...next, responseId: id, responseText: text};
				events.push({kind: "item", item: assistantItem(id, timestamp, text)});
			}
			break;

		case "tool":
		case "subagent": {
			const name = step.tool_name ?? step.tool_info?.name;
			if (name === undefined) {
				events.push(
					systemEvent(
						key,
						timestamp,
						`agy ${step.step_type} step ${step.step_index} names no tool (${step.state})`,
					),
				);
				break;
			}
			const status = toolStatusOf(step.state);
			const input =
				step.subagent_info === undefined
					? (step.tool_info?.parameters ?? null)
					: subagentInput(step.subagent_info);
			events.push({
				kind: "item",
				item: toolItem({
					id: key,
					timestamp,
					name,
					input,
					result: toolResultText(step, status),
					status,
				}),
			});
			break;
		}

		case "system_message":
			if (delta.length > 0) events.push(systemEvent(key, timestamp, delta));
			break;

		default:
			events.push(systemEvent(key, timestamp, unrecognisedText(step)));
	}

	if (step.usage !== undefined) {
		const tokens = tokensOf(step.usage);
		events.push(
			usageEvent(next.model, stepUsageKey(step.conversation_id, step.step_index), tokens),
		);
		next = {
			...next,
			reported: {
				inputTokens: next.reported.inputTokens + tokens.inputTokens,
				outputTokens: next.reported.outputTokens + tokens.outputTokens,
			},
		};
	}
	return {events, next};
};

const resultEvents = (previous: AgyTurn, result: AgyResult, timestamp: number): Folded => {
	const events: Array<AgentEvent> = [];
	let minted = previous.minted;
	const stopped = wasInterrupted(result);

	// A stopped turn carries no `response` — the reply it was writing is the carry's, and the row is
	// minted even when that is empty too, because the mark has to sit on a row.
	if (result.response.length > 0 || stopped) {
		const id = previous.responseId ?? itemId(`${result.conversation_id}:response`);
		const text = result.response.length > 0 ? result.response : previous.responseText;
		events.push({
			kind: "item",
			item: stopped
				? interruptedItem(id, timestamp, text)
				: assistantItem(id, timestamp, result.response),
		});
	}

	const denied = result.denied_actions;
	if (denied !== undefined && denied.length > 0) {
		events.push(
			systemEvent(
				`agy:denied:${minted}`,
				timestamp,
				`agy denied ${denied.length} action(s): ${JSON.stringify(denied)}`,
			),
		);
		minted += 1;
	}

	const residual = minus(turnTokensOf(previous, result), previous.reported);
	if (spent(residual)) {
		events.push(
			usageEvent(
				previous.model,
				turnUsageKey(result.conversation_id, result.num_turns, previous.lastStepIndex),
				residual,
			),
		);
	}

	// Fail closed: only `SUCCESS` is a success, so a status this pin has not seen surfaces as a
	// failure instead of being silently folded into a completed turn. The stop the operator asked for
	// is the one `ERROR` that is not one — it is marked on the row above, the way the peers mark it,
	// and a failure here would additionally recover the send the turn really ran (`core/sends.ts`'s
	// `settleFailedTurn`) and leave a refusal standing over a session that did what it was told.
	if (result.status !== "SUCCESS" && !stopped)
		events.push({
			kind: "failure",
			failure: {
				tag: "AgyTurnFailed",
				reason: result.status,
				detail: result.error ?? "agy ended the turn with no error detail",
			},
		});

	return {
		events,
		next: {
			...previous,
			responseId: null,
			responseText: "",
			minted,
			reported: noTokens,
			lastStepIndex: null,
			cumulative: result.usage === undefined ? previous.cumulative : tokensOf(result.usage),
		},
	};
};

/**
 * One NDJSON line → zero or more `AgentEvent`s, plus the carry the next line folds against.
 *
 * `timestamp` is the caller's wall clock in epoch milliseconds: agy stamps nothing, and the port's
 * items all carry one.
 */
export const eventsOf = (previous: AgyTurn, line: string, timestamp: number): Folded => {
	const read = decodeLine(line);
	switch (read.kind) {
		case "blank":
			return {events: [], next: previous};

		case "unreadable": {
			const raw =
				read.raw.length <= UNREADABLE_LINE_LIMIT
					? read.raw
					: `${read.raw.slice(0, UNREADABLE_LINE_LIMIT)}…`;
			return {
				events: [
					systemEvent(
						`agy:unreadable:${previous.minted}`,
						timestamp,
						`agy emitted a line this reader cannot use (${read.reason}): ${raw}`,
					),
				],
				next: {...previous, minted: previous.minted + 1},
			};
		}

		case "event":
			switch (read.event.event) {
				// `init` names the model and nothing the transcript renders; the layer reads the rest
				// of it directly for `StartedSession`, and the model catalog is its own invocation.
				case "init": {
					const model = read.event.init.model;
					return {
						events: [],
						next: {...previous, model: model === undefined ? "agy" : `agy/${model}`},
					};
				}
				case "step_update":
					return stepEvents(previous, read.event.step_update, timestamp);
				case "result":
					return resultEvents(previous, read.event.result, timestamp);
			}
	}
};
