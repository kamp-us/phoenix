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
import type {
	CommandRef,
	Mode,
	ModelRef,
	PermissionDecision,
	ThinkingLevel,
	TranscriptItem,
} from "../ports/index.ts";
import type {
	ModelUnsupported,
	ModeUnsupported,
	PageError,
	PromptError,
	StartError,
	ThinkingUnsupported,
	TransportError,
	UnknownRequest,
} from "./errors.ts";

export interface StartOptions {
	readonly cwd: string;
	/** A session id an earlier run returned. Absent starts a new session. */
	readonly resume?: string;
	/**
	 * The mode to open on, which is how a restored session keeps the operator's switch (#7953). A
	 * layer holds its mode in its own build, so a rebuilt one holds none and would otherwise open on
	 * the row's configured mode and announce that. Re-applying the mode after `started` landed would
	 * leave a window in which the session runs on one mode and says another, which is the thing
	 * #7828 closed — so it is handed over here, before the query exists.
	 *
	 * Absent means "whatever the layer would open on anyway". A layer that offers no modes ignores
	 * it.
	 */
	readonly mode?: Mode;
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
	 * Switch the model this session runs on — the eighth member (#7981). The founder picks the model
	 * from the composer, so it is an act of the generic interface rather than of a backend. A ref
	 * outside the layer's offered set fails; the offered set itself arrives on `events` as a `model`
	 * event, exactly as the mode list does.
	 */
	readonly setModel: (model: ModelRef) => Effect.Effect<void, ModelUnsupported>;
	/**
	 * The slash commands this session offers, as the composer's picker lists them — the ninth member
	 * (#8060). A read rather than a setter, because nothing selects a command: the picker inserts one
	 * and it reaches the backend as ordinary prompt text.
	 *
	 * The catalog is the session's, so this answers empty before `start` and on a backend that offers
	 * none. Changes arrive on `events` as a `commands` event rather than down a second stream — one
	 * subscription, one ordering (ruling 1, #7570) — and this read always answers what the last such
	 * event carried.
	 */
	readonly commands: Effect.Effect<ReadonlyArray<CommandRef>>;
	/**
	 * How hard the session thinks — the tenth member (#8062), and `setModel`'s shape exactly. The
	 * founder ruled that each backend offers only the levels it really supports rather than mapping
	 * the ones it lacks onto something, so the offered set is per backend *and* per model and rides
	 * `events` as a `thinking` event; a level outside it fails.
	 */
	readonly setThinkingLevel: (level: ThinkingLevel) => Effect.Effect<void, ThinkingUnsupported>;
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
