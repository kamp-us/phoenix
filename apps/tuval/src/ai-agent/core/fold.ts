/**
 * Folding one `AgentEvent` into the session state — the half of `update` that has nothing to do
 * with Cmds, kept apart so the transition table below reads as a table.
 *
 * The transcript half is the only one that can lose data, and it loses it on purpose: every new
 * item goes through `planTranscriptWindow`, so the tail in state is whatever the bounds admit and
 * the running omission totals carry what they dropped. A refused plan leaves the tail as it was —
 * the planner answers with data rather than throwing, so this does too.
 */

import type {AgentEvent, Phase} from "../events.ts";
import {isRefusal, planTranscriptWindow} from "../history/index.ts";
import type {TranscriptItem, TranscriptPayload, WindowOmission} from "../ports/index.ts";
import type {AiAgentSessionState, UsageTotals} from "./state.ts";

/** How much tail one session keeps. Absent, the window module's own defaults apply. */
export interface WindowLimits {
	readonly itemLimit?: number;
	readonly byteLimit?: number;
}

/** An item with a known id supersedes the one it names, in place; anything else is the new tail. */
export const upsertItem = (
	items: ReadonlyArray<TranscriptItem>,
	item: TranscriptItem,
): ReadonlyArray<TranscriptItem> => {
	const at = items.findIndex((candidate) => candidate.id === item.id);
	return at < 0
		? [...items, item]
		: items.map((candidate, index) => (index === at ? item : candidate));
};

const addOmission = (carried: WindowOmission, dropped: WindowOmission): WindowOmission => ({
	items: carried.items + dropped.items,
	bytes: carried.bytes + dropped.bytes,
	reason: dropped.reason === "none" ? carried.reason : dropped.reason,
});

export const foldItem = (
	transcript: TranscriptPayload,
	item: TranscriptItem,
	limits: WindowLimits,
): TranscriptPayload => {
	const planned = planTranscriptWindow(upsertItem(transcript.items, item), limits);
	return isRefusal(planned)
		? transcript
		: {items: planned.items, omitted: addOmission(transcript.omitted, planned.omitted)};
};

export const addUsage = (
	usage: UsageTotals,
	event: Extract<AgentEvent, {kind: "usage"}>,
): UsageTotals => ({
	model: event.model,
	inputTokens: usage.inputTokens + event.inputTokens,
	outputTokens: usage.outputTokens + event.outputTokens,
	cost: usage.cost + event.cost,
});

const without = <A>(
	pending: Readonly<Record<string, A>>,
	request: string,
): Readonly<Record<string, A>> =>
	Object.fromEntries(Object.entries(pending).filter(([id]) => id !== request));

export const dropRequest = (state: AiAgentSessionState, request: string): AiAgentSessionState => ({
	...state,
	permissions: without(state.permissions, request),
});

/**
 * The two phases only the core's own cells may enter. `start` and `reconnect` are what put a
 * session into an open, and `started` or `failed` are the only ways out of one, so a layer cannot
 * tell the core about an open the core did not start.
 *
 * Every layer narrates its own open on the event stream — `PiAiAgent.start` and
 * `ClaudeAiAgent.start` both emit `starting` and then `ready` — and that stream is opened by the
 * `started` the open already answered (`machine.ts`, `subscriptions`). So the `starting` a Sub
 * reads first is always a report about an open that is finished, and folding it walks a ready
 * session backwards into a phase that refuses every prompt (#7925).
 */
const coreOwned = (phase: Phase): boolean => phase === "starting" || phase === "reconnecting";

export const foldEvent = (
	state: AiAgentSessionState,
	event: AgentEvent,
	limits: WindowLimits,
): AiAgentSessionState => {
	switch (event.kind) {
		case "item":
			return {...state, transcript: foldItem(state.transcript, event.item, limits)};
		case "phase":
			return coreOwned(event.phase) ? state : {...state, phase: event.phase};
		case "permission":
			return {...state, permissions: {...state.permissions, [event.request]: event.detail}};
		case "permission-resolved":
			return dropRequest(state, event.request);
		case "mode":
			return {...state, modes: {current: event.current, available: event.available}};
		case "usage":
			return {...state, usage: addUsage(state.usage, event)};
	}
};
