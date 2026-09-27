import {PROTOCOL_VERSION as PI_PROTOCOL_VERSION} from "@earendil-works/pi-protocol";
import type {ModelMetadata, ModelRef, ThinkingLevel} from "./model.ts";
import type {TranscriptItem, UserTranscriptItem} from "./transcript.ts";

/** The envelope version both ends negotiate, read off the package rather than restated. */
export const PROTOCOL_VERSION = PI_PROTOCOL_VERSION;

/** Matches AgentHarnessPhase so adapters do not need a second phase vocabulary. */
export type SessionPhase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";

export interface SessionMetadata {
	readonly id: string;
	readonly createdAt: number;
	readonly updatedAt?: number;
	readonly parentSessionId?: string;
	readonly sessionName?: string;
	readonly cwd?: string;
}

export interface SessionSnapshot {
	readonly id: string;
	readonly name?: string;
	readonly cwd: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly phase: SessionPhase;
	readonly model: ModelRef;
	readonly thinkingLevel: ThinkingLevel;
	readonly attached: boolean;
	readonly locked: boolean;
	readonly revision: number;
	readonly transcript: TranscriptItem[];
	readonly queuedSteer: UserTranscriptItem[];
	readonly queuedSteerCount: number;
}

export interface ServerSnapshot {
	readonly serverId: string;
	readonly protocolVersion: typeof PROTOCOL_VERSION;
	readonly revision: number;
	readonly sessions: SessionMetadata[];
	readonly models: ModelMetadata[];
}

/**
 * What one revision changed, for a viewer that already holds the previous whole value.
 *
 * Every field beside the three below is optional and means *unchanged when absent*, which is what
 * keeps a streamed turn's per-token frame to the one item that moved instead of the transcript.
 * `./delta.ts` owns both halves of that reading — the diff that builds one and the apply
 * that folds one back into a `SessionSnapshot`.
 */
export interface SessionDelta {
	readonly id: string;
	readonly revision: number;
	readonly updatedAt: number;
	readonly name?: string;
	readonly phase?: SessionPhase;
	readonly model?: ModelRef;
	readonly thinkingLevel?: ThinkingLevel;
	readonly attached?: boolean;
	readonly locked?: boolean;
	readonly queuedSteer?: UserTranscriptItem[];
	readonly queuedSteerCount?: number;
	/** Transcript items that appeared or changed, in transcript order. */
	readonly items?: TranscriptItem[];
}
