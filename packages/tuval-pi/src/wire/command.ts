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

/**
 * Protocol 8's error object is `{code, message}` with `additionalProperties: false`, so a refusal
 * says everything it has to say in its message — there is no structured `details` slot to put a
 * session id in.
 */
export interface ProtocolError {
	readonly code: ProtocolErrorCode;
	readonly message: string;
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

/**
 * `attachmentId` is the lease the host just issued. Every later call on this session addresses it
 * through a `SessionTarget` carrying that id, so a call made on a lease the host has since
 * replaced is refused rather than served — which is the fence the 0.84.3 protocol had no room for.
 */
export interface CreateResult {
	readonly command: "create";
	readonly session: SessionSnapshot;
	readonly attachmentId: string;
}

export interface AttachResult {
	readonly command: "attach";
	readonly session: SessionSnapshot;
	readonly attachmentId: string;
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
