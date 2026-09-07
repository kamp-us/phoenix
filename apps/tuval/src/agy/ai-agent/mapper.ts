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
 * - **`result.usage` is the turn's total, not another increment** — field by field it is the sum of
 *   the step usages already reported, while the core's `addUsage` folds every usage event by plain
 *   addition. So the turn carries what it has reported and the `result` reports only the residual.
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
 * **An unrecognised `step_type` renders a `SystemItem` and is never dropped and never thrown on.**
 * That is the whole reason this file has a default arm: the enum is provably open and the stream
 * carries no version to branch on (see `wire.ts`).
 */

import type {AgentEvent} from "../../ai-agent/events.ts";
import type {ItemId, JsonValue, ToolStatus} from "../../ai-agent/ports/index.ts";
import {assistantItem, itemId, systemItem, toolItem, toolStatusOf, userItem} from "./items.ts";
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

/** What this turn has already handed the core, so `result.usage` can be reported as a residual. */
interface ReportedUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
}

const nothingReported: ReportedUsage = {inputTokens: 0, outputTokens: 0};

/** The ledger key one usage report is folded under; see `AgyTurn.usageReports`. */
const usageKey = (report: number): string => `agy:usage:${report}`;

export interface AgyTurn {
	/**
	 * How many usage reports this *session* has already handed the core — the ordinal each one is
	 * keyed by. The core keys a cost on `UsageEvent.turn` and keeps the *first* report under a key it
	 * has seen (`../../ai-agent/core/fold.ts`); agy reports usage as increments *within* a turn
	 * (steps, then the residual at `result`) and never restates one, so keying every report on the
	 * turn itself would drop every increment after the first. Keyed per report, the ledger sums them
	 * and the dedupe is the no-op it should be for a backend that never re-reports.
	 *
	 * The carry this rides on is minted per agy *child*, and a `setModel` / `setMode` /
	 * `setThinkingLevel` respawn hands the same core state a second child. So the ordinal cannot
	 * originate here: the layer owns it (`AgyAiAgent.ts`, a `Ref` beside `interrupted`), seeds each
	 * child's carry from it through `turnFrom`, and mirrors it back after every fold. Restarting it
	 * at `0` on a respawn would alias keys the ledger has already spent and drop the new child's
	 * tokens silently.
	 */
	readonly usageReports: number;
	/** `agy/<model>` once `init` names one, else the bare binary — agy omits `init.model` on a default run. */
	readonly model: string;
	/** The item this turn's reply streams into, minted at its first `agent_response` delta. */
	readonly responseId: ItemId | null;
	readonly responseText: string;
	/** Monotonic, so two keyless rows never share an id. */
	readonly minted: number;
	readonly reported: ReportedUsage;
}

export const idleTurn: AgyTurn = {
	model: "agy",
	usageReports: 0,
	responseId: null,
	responseText: "",
	minted: 0,
	reported: nothingReported,
};

/**
 * The carry a freshly launched child folds against, seeded with the session's usage ordinal so the
 * new child's first report cannot collide with a key an earlier child already spent.
 */
export const turnFrom = (usageReports: number): AgyTurn => ({...idleTurn, usageReports});

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
const usageEvent = (
	model: string,
	report: number,
	usage: AgyUsage | undefined,
): UsageEvent | null =>
	usage === undefined
		? null
		: {
				kind: "usage",
				turn: usageKey(report),
				model,
				inputTokens: usage.input_tokens,
				outputTokens: usage.output_tokens,
				cost: 0,
			};

/**
 * What is left of `result.usage` once the steps have reported theirs. A stream whose steps carried
 * no usage still reports the whole total, because then the residual *is* the total. The clamp
 * refuses to hand the core a negative increment if a step ever over-reports against the total.
 */
const residualUsageEvent = (
	model: string,
	report: number,
	reported: ReportedUsage,
	usage: AgyUsage | undefined,
): UsageEvent | null => {
	if (usage === undefined) return null;
	const inputTokens = Math.max(0, usage.input_tokens - reported.inputTokens);
	const outputTokens = Math.max(0, usage.output_tokens - reported.outputTokens);
	return inputTokens === 0 && outputTokens === 0
		? null
		: {kind: "usage", turn: usageKey(report), model, inputTokens, outputTokens, cost: 0};
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
	let next = previous;

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

	const usage = usageEvent(next.model, next.usageReports, step.usage);
	if (usage !== null) {
		events.push(usage);
		next = {
			...next,
			usageReports: next.usageReports + 1,
			reported: {
				inputTokens: next.reported.inputTokens + usage.inputTokens,
				outputTokens: next.reported.outputTokens + usage.outputTokens,
			},
		};
	}
	return {events, next};
};

const resultEvents = (previous: AgyTurn, result: AgyResult, timestamp: number): Folded => {
	const events: Array<AgentEvent> = [];
	let minted = previous.minted;

	if (result.response.length > 0) {
		const id = previous.responseId ?? itemId(`${result.conversation_id}:response`);
		events.push({kind: "item", item: assistantItem(id, timestamp, result.response)});
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

	const usage = residualUsageEvent(
		previous.model,
		previous.usageReports,
		previous.reported,
		result.usage,
	);
	if (usage !== null) events.push(usage);

	// Fail closed: only `SUCCESS` is a success, so a status this pin has not seen surfaces as a
	// failure instead of being silently folded into a completed turn.
	if (result.status !== "SUCCESS")
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
			usageReports: previous.usageReports + (usage === null ? 0 : 1),
			reported: nothingReported,
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
