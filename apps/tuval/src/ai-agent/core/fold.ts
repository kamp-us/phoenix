/**
 * Folding one `AgentEvent` into the session state — the half of `update` that has nothing to do
 * with Cmds, kept apart so the transition table below reads as a table.
 *
 * The transcript half is the only one that can lose data, and it loses it on purpose: every new
 * item goes through `planTranscriptWindow`, so the tail in state is whatever the bounds admit and
 * the running omission totals carry what they dropped. A refused plan leaves the tail as it was —
 * the planner answers with data rather than throwing, so this does too.
 *
 * The transcript has one other entrance, and it is here too: the operator's own turn, recorded by
 * the `prompt` cell the moment they send it rather than when a layer gets round to echoing it
 * (#7978). That is the item `upsertItem`'s echo join exists for.
 */

import type {AgentEvent, AgentFailure, Phase} from "../events.ts";
import {isRefusal, planTranscriptWindow} from "../history/index.ts";
import {
	ItemId,
	type PendingPermission,
	type PermissionProgress,
	type TranscriptItem,
	type TranscriptPayload,
	type UserItem,
	type WindowOmission,
} from "../ports/index.ts";
import {START_ERROR} from "./failures.ts";
import type {AiAgentSessionState, UsageTotals} from "./state.ts";

/** How much tail one session keeps. Absent, the window module's own defaults apply. */
export interface WindowLimits {
	readonly itemLimit?: number;
	readonly byteLimit?: number;
}

/** A locally-recorded turn's id, derived from the prompt's idempotency key so it is stable. */
export const promptItemId = (key: string): ItemId => ItemId.make(`local:${key}`);

/** The operator's turn as the core records it on send, before any layer has confirmed it. */
export const promptItem = (prompt: {
	readonly text: string;
	readonly key: string;
	readonly timestamp: number;
}): UserItem => ({
	kind: "user",
	id: promptItemId(prompt.key),
	timestamp: prompt.timestamp,
	text: prompt.text,
	local: true,
});

/**
 * Where a layer's echo of a locally-recorded turn belongs, or `-1`.
 *
 * Text is the only join the core has: the layer mints the turn under its own id, so an id lookup
 * would append the echo beside the item it is a copy of. Matching is confined to items still
 * carrying `local` — an echo that already landed cleared the flag — and a locally-recorded item
 * never reconciles against another one, so two deliberate sends of the same text stay two turns.
 */
const echoOf = (items: ReadonlyArray<TranscriptItem>, item: TranscriptItem): number =>
	item.kind !== "user" || item.local === true
		? -1
		: items.findIndex(
				(candidate) =>
					candidate.kind === "user" && candidate.local === true && candidate.text === item.text,
			);

/** An item with a known id supersedes the one it names, in place; anything else is the new tail. */
export const upsertItem = (
	items: ReadonlyArray<TranscriptItem>,
	item: TranscriptItem,
): ReadonlyArray<TranscriptItem> => {
	const byId = items.findIndex((candidate) => candidate.id === item.id);
	const at = byId < 0 ? echoOf(items, item) : byId;
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

/** A card whose answer is out. The narrowing is what lets a caller read the decision unguarded. */
export type AnsweringPermission = PendingPermission & {
	readonly progress: Extract<PermissionProgress, {readonly status: "answering"}>;
};

/**
 * The card one answer's confirmation belongs to, or `null` when it belongs to nothing any more.
 *
 * Both operands have to match: the id says which card, and the `seq` says which *raising* of that
 * id. A reply that outlived its own card is stale, and clearing whatever sits under the id would
 * settle a request nobody has answered.
 */
export const awaitingAnswer = (
	state: AiAgentSessionState,
	request: string,
	seq: number,
): AnsweringPermission | null => {
	const held = state.permissions[request];
	if (held === undefined || held.seq !== seq) return null;
	return held.progress.status === "answering" ? {...held, progress: held.progress} : null;
};

/** The card as it stands once its answer's outcome turns out to be unknown. */
export const unresolvedAnswer = (
	state: AiAgentSessionState,
	request: string,
	held: AnsweringPermission,
): AiAgentSessionState => ({
	...state,
	permissions: {
		...state.permissions,
		[request]: {...held, progress: {status: "unresolved", decision: held.progress.decision}},
	},
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

/** The backend does not hold the session this resume named. */
const sessionGone = (failure: AgentFailure): boolean =>
	failure.tag === START_ERROR && failure.reason === "session-not-found";

/**
 * Where a failure leaves a session: back where it was before the act that failed.
 *
 * A resume is the exception, because there is nowhere before it to go back to. A refused resume
 * ends the session at `gone` — the id the checkpoint carried names nothing the backend still
 * holds, and the one thing that must never happen is a fresh session opening quietly in its place
 * (#7514). Any other reconnect failure is a transport that can be tried again, so it lands on
 * `idle` rather than staying at `reconnecting`, which the reconnect guard itself would refuse.
 */
export const phaseAfterFailure = (
	state: AiAgentSessionState,
	failure: AgentFailure,
): AiAgentSessionState["phase"] => {
	if (state.phase === "reconnecting") return sessionGone(failure) ? "gone" : "idle";
	if (state.phase === "starting") return "idle";
	if (state.phase === "prompting") return "ready";
	return state.phase;
};

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
		// A raising stamps the next `seq`, which is what makes a card's identity the raising rather
		// than the id: a backend that re-uses a request id gets a second card, and the first card's
		// answer can no longer settle it (#8006).
		case "permission": {
			const seq = state.permissionsRaised + 1;
			return {
				...state,
				permissionsRaised: seq,
				permissions: {
					...state.permissions,
					[event.request]: {request: event.detail, seq, progress: {status: "open"}},
				},
			};
		}
		case "permission-resolved":
			return dropRequest(state, event.request);
		case "mode":
			return {...state, modes: {current: event.current, available: event.available}};
		case "model":
			return {...state, models: {current: event.current, available: event.available}};
		// Replaced, never merged: the push carries the whole list, so a merge would keep a command
		// the backend has just withdrawn.
		case "commands":
			return {...state, commands: event.available};
		case "usage":
			return {...state, usage: addUsage(state.usage, event)};
		// The same landing the `failed` Msg gives a failure the handlers saw, so a refusal reads the
		// same to the window whichever channel carried it. Routing it through `event` is what keeps
		// the machine's identity filter over it: a late refusal from a session this process has
		// already replaced is dropped rather than failing its successor (#8018).
		case "failure":
			return {
				...state,
				phase: phaseAfterFailure(state, event.failure),
				failure: event.failure,
			};
	}
};
