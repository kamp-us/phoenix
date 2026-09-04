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
 */

import type {Mode, PermissionDecision, PermissionRequest, TranscriptItem} from "../ports/index.ts";

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
	| UsageEvent;
