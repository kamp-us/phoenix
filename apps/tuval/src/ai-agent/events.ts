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
	TranscriptItem,
} from "./ports/index.ts";

/**
 * Where a session is, as the core's `ai-agent-session` machine names it (#7497). The layer
 * reports it; the machine stores it and the window renders the phase line off that.
 */
export type Phase = "idle" | "starting" | "ready" | "prompting" | "reconnecting" | "gone";

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

/** Plain numbers and a plain model name: no backend's usage type reaches the core. */
export interface UsageEvent {
	readonly kind: "usage";
	readonly model: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cost: number;
}

export type AgentEvent =
	| ItemEvent
	| PhaseEvent
	| PermissionEvent
	| PermissionResolvedEvent
	| ModeEvent
	| ModelEvent
	| CommandsEvent
	| UsageEvent
	| FailureEvent;
