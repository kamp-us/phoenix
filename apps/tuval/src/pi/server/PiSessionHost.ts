/**
 * The seam between the wire and Pi. Everything on the far side of this port is a real
 * `AgentSession` plus its JSONL `SessionManager`; everything on this side is protocol values, so
 * the dispatch, the ownership table and the connection plumbing are all testable without a model.
 * Pi's own types stop at the port's implementation, never at its callers.
 */

import type {
	ModelMetadata,
	ModelRef,
	SessionPhase,
	ThinkingLevel,
	TranscriptItem,
} from "@earendil-works/pi-protocol";
import {Context, type Effect} from "effect";
import type {SessionCallFailed, SessionOpenFailed} from "./errors.ts";

/** Everything a `session_snapshot` needs that the session itself owns. */
export interface PiSessionView {
	readonly phase: SessionPhase;
	readonly model: ModelRef;
	readonly thinkingLevel: ThinkingLevel;
	readonly transcript: ReadonlyArray<TranscriptItem>;
	readonly name: string | undefined;
	/** Steering messages accepted but not yet delivered, oldest first. */
	readonly queuedSteer: ReadonlyArray<string>;
}

export interface PiSessionHandle {
	readonly id: string;
	readonly cwd: string;
	/** The JSONL transcript's path, or `undefined` for an in-memory session. */
	readonly file: string | undefined;
	readonly createdAt: number;
	readonly read: Effect.Effect<PiSessionView>;
	readonly prompt: (text: string) => Effect.Effect<void, SessionCallFailed>;
	readonly steer: (text: string) => Effect.Effect<void, SessionCallFailed>;
	readonly abort: Effect.Effect<void, SessionCallFailed>;
	readonly setModel: (model: ModelRef) => Effect.Effect<void, SessionCallFailed>;
	readonly setThinkingLevel: (level: ThinkingLevel) => Effect.Effect<void, SessionCallFailed>;
	/** Completes once the session has changed since the last completion; bursts coalesce. */
	readonly changes: Effect.Effect<void>;
	/** Called exactly once, by the server, when the session leaves the table. */
	readonly dispose: Effect.Effect<void>;
}

export interface OpenSessionOptions {
	readonly cwd: string;
	readonly name?: string | undefined;
	readonly model?: ModelRef | undefined;
	readonly thinkingLevel?: ThinkingLevel | undefined;
}

export interface PiSessionHostApi {
	readonly models: Effect.Effect<ReadonlyArray<ModelMetadata>>;
	readonly open: (options: OpenSessionOptions) => Effect.Effect<PiSessionHandle, SessionOpenFailed>;
	/**
	 * Re-open a session this host does not hold, off the store it left behind.
	 *
	 * The table is per server and a server is per process, so after a restart every session a
	 * checkpoint names is one this host never opened — and an `attach` that could only claim a live
	 * record would answer `not_found` for a session whose whole transcript is on disk (#7609). A
	 * host with nowhere to look answers `SessionOpenFailed`, which the dispatch reads as the same
	 * `not_found` it would have given, so "the backend does not hold this session" stays one fact
	 * with one wire code.
	 */
	readonly resume: (sessionId: string) => Effect.Effect<PiSessionHandle, SessionOpenFailed>;
}

export class PiSessionHost extends Context.Service<PiSessionHost, PiSessionHostApi>()(
	"tuval/pi/PiSessionHost",
) {}
