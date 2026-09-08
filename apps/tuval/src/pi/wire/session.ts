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
