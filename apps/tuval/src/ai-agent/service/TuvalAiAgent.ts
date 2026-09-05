/**
 * `TuvalAiAgent` — the one service every agent program implements with a layer.
 *
 * Everything above this line is generic (founder ruling, 2026-09-02): the core machine, the
 * handlers, the row factory and the window all speak this surface, and the only program-specific
 * code is the layer under it — `PiAiAgent.layer`, `ClaudeAiAgent.layer`, `ScriptedAiAgent.layer`.
 *
 * Two rules make that substitutability real, and both are pinned in `boundary.unit.test.ts`:
 * nothing here returns a `Promise`, and no backend's wire type appears on any signature. A layer
 * wrapping a Promise-shaped SDK wraps it at its own boundary, never at a call site
 * (`.patterns/effect-context-service.md`).
 *
 * A layer is built inside the process's Scope (#7513, ruling 4): building it acquires the
 * transport and closing the Scope tears it down. `start` is therefore the handler's call, not the
 * layer's, and restore is "rebuild the layer, then `start({cwd, resume: sessionId})`".
 */

import {Context, type Effect, type Stream} from "effect";
import type {AgentEvent} from "../events.ts";
import type {Mode, PermissionDecision, TranscriptItem} from "../ports/index.ts";
import type {
	ModeUnsupported,
	PageError,
	PromptError,
	StartError,
	TransportError,
	UnknownRequest,
} from "./errors.ts";

export interface StartOptions {
	readonly cwd: string;
	/** A session id an earlier run returned. Absent starts a new session. */
	readonly resume?: string;
}

export interface StartedSession {
	readonly sessionId: string;
}

/** One page of history, oldest-first. `hasMore` is false once the page reaches the beginning. */
export interface TranscriptPage {
	readonly items: ReadonlyArray<TranscriptItem>;
	readonly hasMore: boolean;
}

export interface TuvalAiAgentApi {
	readonly start: (options: StartOptions) => Effect.Effect<StartedSession, StartError>;
	/**
	 * Returns at the send, never at the end of the turn (#8018). The generic host awaits a Cmd
	 * handler before publishing the commit that handler came from, so a layer that resolves this at
	 * the turn's end holds the operator's own message off the window until the reply lands. A
	 * backend whose send is one turn-long call forks the await and routes what it can no longer
	 * return onto `events`.
	 *
	 * `key` is the idempotency key (ruling 2): a second prompt carrying a key this session already
	 * saw is dropped rather than re-sent, so a transport-level retry of one send is free. A
	 * deliberate resend — the one the window offers after an interrupted turn — mints a new key.
	 */
	readonly prompt: (text: string, key?: string) => Effect.Effect<void, PromptError>;
	readonly interrupt: Effect.Effect<void>;
	readonly answer: (
		request: string,
		decision: PermissionDecision,
	) => Effect.Effect<void, UnknownRequest>;
	readonly setMode: (mode: Mode) => Effect.Effect<void, ModeUnsupported>;
	/**
	 * History is backend-owned (ruling 5): this reads the backend's own store through the
	 * transport. Tuval keeps no second copy beyond the live tail the core holds.
	 */
	readonly page: (before: string | null, limit: number) => Effect.Effect<TranscriptPage, PageError>;
	readonly events: Stream.Stream<AgentEvent, TransportError>;
}

export class TuvalAiAgent extends Context.Service<TuvalAiAgent, TuvalAiAgentApi>()(
	"tuval/TuvalAiAgent",
) {}
