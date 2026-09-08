import type {JsonValue} from "./json.ts";
import type {ModelRef, ThinkingLevel} from "./model.ts";
import type {SessionMetadata, SessionSnapshot} from "./session.ts";

export type ProtocolErrorCode =
	| "version"
	| "busy"
	| "session_locked"
	| "not_found"
	| "invalid_request"
	| "not_implemented"
	| "internal_error";

export interface ProtocolError {
	readonly code: ProtocolErrorCode;
	readonly message: string;
	readonly details?: JsonValue;
}

export interface ListCommand {
	readonly command: "list";
}

export interface CreateCommand {
	readonly command: "create";
	readonly cwd?: string;
	readonly name?: string;
	readonly model?: ModelRef;
	readonly thinkingLevel?: ThinkingLevel;
}

export interface AttachCommand {
	readonly command: "attach";
	readonly sessionId: string;
}

export interface DetachCommand {
	readonly command: "detach";
	readonly sessionId: string;
}

export interface PromptCommand {
	readonly command: "prompt";
	readonly sessionId: string;
	readonly text: string;
}

export interface SteerCommand {
	readonly command: "steer";
	readonly sessionId: string;
	readonly text: string;
}

export interface AbortCommand {
	readonly command: "abort";
	readonly sessionId: string;
}

export interface SetModelCommand {
	readonly command: "set_model";
	readonly sessionId: string;
	readonly model: ModelRef;
}

export interface SetThinkingCommand {
	readonly command: "set_thinking";
	readonly sessionId: string;
	readonly thinkingLevel: ThinkingLevel;
}

export type Command =
	| ListCommand
	| CreateCommand
	| AttachCommand
	| DetachCommand
	| PromptCommand
	| SteerCommand
	| AbortCommand
	| SetModelCommand
	| SetThinkingCommand;

export interface ListResult {
	readonly command: "list";
	readonly sessions: SessionMetadata[];
}

export interface CreateResult {
	readonly command: "create";
	readonly session: SessionSnapshot;
}

export interface AttachResult {
	readonly command: "attach";
	readonly session: SessionSnapshot;
}

export interface DetachResult {
	readonly command: "detach";
	readonly sessionId: string;
}

export interface PromptResult {
	readonly command: "prompt";
	readonly session: SessionSnapshot;
}

export interface SteerResult {
	readonly command: "steer";
	readonly session: SessionSnapshot;
}

export interface AbortResult {
	readonly command: "abort";
	readonly session: SessionSnapshot;
}

export interface SetModelResult {
	readonly command: "set_model";
	readonly session: SessionSnapshot;
}

export interface SetThinkingResult {
	readonly command: "set_thinking";
	readonly session: SessionSnapshot;
}

export type CommandResult =
	| ListResult
	| CreateResult
	| AttachResult
	| DetachResult
	| PromptResult
	| SteerResult
	| AbortResult
	| SetModelResult
	| SetThinkingResult;
