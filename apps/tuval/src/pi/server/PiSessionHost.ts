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
}

export class PiSessionHost extends Context.Service<PiSessionHost, PiSessionHostApi>()(
	"tuval/pi/PiSessionHost",
) {}
