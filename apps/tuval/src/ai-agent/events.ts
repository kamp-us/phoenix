/**
 * `AgentEvent` — the one union every `TuvalAiAgent` layer pushes onto `events`.
 *
 * One stream, one ordering (founder ruling 1, #7570): every kind rides the same subscription so
 * the core folds a single sequence rather than racing five. `item` carries a whole transcript
 * item, new or updated: a tool result re-sends the same item id with the new status, which is why
 * the id is stable in `ports/transcript-item.ts` rather than positional.
 *
 * `usage` is the one kind no port carries. It names the model, its token counts and its cost —
 * exactly what the interface refuses to put on a port so one window can render any agent — and it
 * is consumed only by the core, which owns the cumulative totals.
 *
 * `failure` is how a live session reports a turn that went wrong. Ending the stream is the other
 * way, and it is reserved for a transport that is actually gone: a queue failed once stays failed,
 * and the host will not re-arm the Sub under the same id, so failing it for a refusal the session
 * survived leaves a window that renders nothing ever again (#8018).
 *
 * It sits above `service/` rather than inside it because both sides of the seam speak it: the
 * layers push it and the core machine folds it, and the core may import nothing from `service/`
 * (#7601).
 */

import type {
	CommandRef,
	Mode,
	ModelRef,
	PermissionDecision,
	PermissionRequest,
	SubagentSlot,
	ThinkingLevel,
	TranscriptItem,
	TurnResult,
} from "./ports/index.ts";

/**
 * Where a session is, as the core's `ai-agent-session` machine names it (#7497). The layer
 * reports it; the machine stores it and the window renders the phase line off that.
 *
 * **When a layer owes one.** Per turn, exactly twice: `prompting` as the turn starts and `ready`
 * as it ends, however it ended. `starting` and `reconnecting` are the core's own — it is already
 * inside the open a layer would be describing — so `coreOwned` in `core/fold.ts` drops both, and a
 * layer sending one writes to a channel nobody reads. `idle` is the core's initial state
 * (`core/state.ts`, `initialState`) and no layer sends it; `gone` is the layer's terminal report,
 * for a transport that is actually away.
 *
 * **What omitting the turn-end `ready` costs.** The `prompt` cell in `core/machine.ts` has an arm
 * per case: at `ready` it admits the send, at `prompting` it *queues* it (`enqueue`, bounded by
 * `queueLimit` in `core/queue.ts`, #8159) and answers `promptQueueFull` only once the queue is
 * full, and every other phase is `promptRefused`. The queue's head is admitted by `settleQueue`,
 * and only when the session comes back to `ready`. So a turn left at `prompting` never refuses
 * outright — it silently swallows each later prompt into a queue that never drains, then answers
 * `promptQueueFull` for the rest of the session. Nothing types it: `ResultEvent` below names a
 * turn's end, but no signature makes a layer send either that or this phase, so the
 * omission compiles and passes every generic test — #7963 (Claude sent no turn-end phase at all)
 * and #7897 (Pi sent it and the host's queue coalesced it away) are the two that shipped. The
 * shape a layer holds it with is in
 * [`.patterns/agent-layer-phase-contract.md`](../../../../.patterns/agent-layer-phase-contract.md).
 */
export type Phase = "idle" | "starting" | "ready" | "prompting" | "reconnecting" | "gone";

/**
 * One turn is over, and this is what it came to (#8724).
 *
 * The turn-end `ready` says a turn ended; it does not say what the turn *answered*, and a consumer
 * outside the window has no transcript to read it off. So the layer owes this beside that phase,
 * once per finished turn however the turn ended — a failed or interrupted turn lands here with
 * `ok: false` rather than not landing at all. The program folds it and publishes it on `result`
 * (`./ports/ports.ts`).
 *
 * It rides ahead of the phase that closes the turn, so a `session-reset` — which is one turn's end
 * and the conversation swap in a single event — still carries this turn's answer under the id it
 * was run on.
 *
 * `withTurnResult` in `./service/turn-result.ts` derives it from the events a layer already emits,
 * which is how every layer pays this without five copies of the same bookkeeping.
 */
export interface ResultEvent {
	readonly kind: "result";
	readonly result: TurnResult;
}

/** A transcript item arrived or changed. Same `item.id` twice means the later one supersedes. */
export interface ItemEvent {
	readonly kind: "item";
	readonly item: TranscriptItem;
}

export interface PhaseEvent {
	readonly kind: "phase";
	readonly phase: Phase;
}

/** A permission card the agent is waiting on. `request` is the id `answer` takes. */
export interface PermissionEvent {
	readonly kind: "permission";
	readonly request: string;
	readonly detail: PermissionRequest;
}

/** A pending card is gone — answered here, or settled by the backend on its own. */
export interface PermissionResolvedEvent {
	readonly kind: "permission-resolved";
	readonly request: string;
	readonly decision: PermissionDecision;
}

export interface ModeEvent {
	readonly kind: "mode";
	readonly current: Mode | null;
	readonly available: ReadonlyArray<Mode>;
}

/**
 * What the session is running on now, and what it may be switched to. `available` is the layer's
 * *offered* set — Pi's authenticated, describable models rather than its whole runtime catalog —
 * because this list is checkpointed with the rest of the session state (#7981).
 */
export interface ModelEvent {
	readonly kind: "model";
	readonly current: ModelRef | null;
	readonly available: ReadonlyArray<ModelRef>;
}

/**
 * What the session offers the composer's slash-command picker, whole.
 *
 * Replaced on arrival, never merged: the Agent SDK's `commands_changed` push is documented as the
 * full list and tells clients to replace their cached one (`sdk.d.ts` at the `0.3.259` pin), and a
 * merge would keep a command the backend has just withdrawn.
 *
 * It rides this stream rather than a member of its own for the reason every other catalog does —
 * one subscription, one ordering (ruling 1, #7570).
 */
export interface CommandsEvent {
	readonly kind: "commands";
	readonly available: ReadonlyArray<CommandRef>;
}

/**
 * How hard the session is thinking now, and which levels it may be switched to.
 *
 * `available` is the layer's *offered* set, and it is per backend and per model: Pi advertises the
 * whole vocabulary for a reasoning model and `off` alone otherwise, Claude advertises its effort
 * axis, which has neither `off` nor `minimal` (#8062). A level outside it is refused rather than
 * silently dropped, so the two windows' pickers differ in row count and neither lies.
 */
export interface ThinkingEvent {
	readonly kind: "thinking";
	readonly current: ThinkingLevel | null;
	readonly available: ReadonlyArray<ThinkingLevel>;
}

/**
 * The last thing that went wrong, as data. The layer's typed errors are classes; this keeps only
 * the tag, the case and the detail, because the window renders by tag (ruling 3, #7570) and a
 * class instance is not something a checkpoint can carry.
 *
 * It lives here beside `Phase` rather than in `core/state.ts` because both sides of the seam now
 * speak it: the core stores it, and a layer reporting a failed turn puts one on this stream.
 */
export interface AgentFailure {
	readonly tag: string;
	/** The error's own `reason` case, or `null` for an error class that enumerates none. */
	readonly reason: string | null;
	readonly detail: string;
}

/**
 * A turn failed and the session is still live — the non-terminal half of what used to be a failed
 * queue. The core folds it exactly as it folds the `failed` Msg, so the window renders the same
 * refusal, and the next turn's items still arrive on this same stream.
 */
export interface FailureEvent {
	readonly kind: "failure";
	readonly failure: AgentFailure;
}

/**
 * One subagent's slot, whole, as its mapper last computed it. Same `slot.id` twice means the later
 * one supersedes, exactly as `item` does — the id is the spawning call's, so a worker that writes a
 * hundred lines is a hundred replacements of one row and never a hundred rows.
 *
 * It rides this stream rather than a channel of its own for the reason every other kind does: one
 * subscription, one ordering (founder ruling 1, #7570). A second channel would let a worker's slot
 * arrive before the tool call that spawned it.
 */
export interface SubagentEvent {
	readonly kind: "subagent";
	readonly slot: SubagentSlot;
}

/**
 * The backend has finished a conversation and stood a fresh one up in its place, under the id this
 * carries. The session survives; the conversation does not.
 *
 * A local command answers without a model turn, so no `result` frame follows it and no turn-end
 * `ready` is coming — a `/clear` therefore left the session `prompting` for ever (#8197). This is
 * the turn's end *and* the swap, one event, because they have to commit together: the events Sub is
 * keyed on the session id (`core/messages.ts`), so a second event pushed under the old id after the
 * swap is dropped by the machine's own identity filter.
 *
 * `sessionId` is the backend's id for the new conversation, and the core's `sessionId` becomes it —
 * that is what the next prompt is stamped with and what a checkpoint resumes. Nothing of the old
 * conversation is deleted: its transcript leaves the live tail because it is not this conversation's,
 * and the backend's own store still holds it for the session list.
 */
export interface SessionResetEvent {
	readonly kind: "session-reset";
	readonly sessionId: string;
}

/**
 * What the layer is driving, as a version string — the Claude Code CLI for one row, Pi's adapter
 * for the other.
 *
 * Its own kind rather than a field on `usage`: usage is a turn's spend, keyed on that turn, and a
 * version is a fact about the session that arrives whether or not anything was spent. It replaces
 * whatever the slot held, so a layer that re-announces on a resume is a no-op.
 */
export interface VersionEvent {
	readonly kind: "version";
	readonly version: string;
}

/**
 * The account a session booted on: the organization and the plan, and never the email.
 *
 * Both fields are optional because absence has three causes and none of them is an error — a layer
 * with no account concept at all (Pi, Codex), a Claude login that carries neither (an API key, a
 * third-party provider, where `AccountInfo`'s fields are documented absent at the `0.3.259` pin),
 * and a CLI that answers the handshake with an empty object. A required field would have to be
 * filled with a placeholder for all three, and the placeholder is what would reach the render.
 *
 * `email` is on the SDK's `AccountInfo` and is deliberately not a field here: the founder ruled org
 * and plan only (#8649), so it is never carried rather than carried and filtered at the edge.
 */
export interface AgentAccount {
	readonly organization?: string;
	readonly subscriptionType?: string;
}

/**
 * Which account the session booted on.
 *
 * Its own kind for `VersionEvent`'s reason: it is a fact about the session that arrives whether or
 * not anything was spent, so it is not a field on `usage`. It replaces whatever the slot held, so a
 * layer that re-announces on a resume is a no-op.
 *
 * "Booted on" is the honest wording, not a hedge. The SDK's `accountInfo()` never refreshes — it
 * answers the object cached at the first connect — while the CLI re-reads the keychain every 30s,
 * so a session whose account changed underneath it still reports the one it opened on (#8447).
 */
export interface AccountEvent {
	readonly kind: "account";
	readonly account: AgentAccount;
}

/** Plain numbers and a plain model name: no backend's usage type reaches the core. */
export interface UsageEvent {
	readonly kind: "usage";
	/**
	 * Which turn this cost belongs to, under the reporting backend's own id for it.
	 *
	 * A report is not an increment. A resume re-reports turns the process has already folded — the
	 * reconnect hands its own tail through as the fold's seed, and a row the restore marked
	 * `interrupted` differs from the backend's copy by that marker alone (#8369) — so the core keys
	 * the cost on this and the second report of one turn adds nothing.
	 */
	readonly turn: string;
	readonly model: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cost: number;
}

export type AgentEvent =
	| ItemEvent
	| PhaseEvent
	| ResultEvent
	| PermissionEvent
	| PermissionResolvedEvent
	| ModeEvent
	| ModelEvent
	| CommandsEvent
	| ThinkingEvent
	| SessionResetEvent
	| UsageEvent
	| VersionEvent
	| AccountEvent
	| SubagentEvent
	| FailureEvent;
