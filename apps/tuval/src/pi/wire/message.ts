import type {Command, CommandResult, ProtocolError} from "./command.ts";
import type {PROTOCOL_VERSION, ServerSnapshot, SessionSnapshot} from "./session.ts";
import type {TranscriptProgress} from "./transcript.ts";

/** Must be the first frame sent by a client. Version is an integer, not a coercible string. */
export interface ClientHello {
	readonly type: "hello";
	readonly version: number;
}

export interface RequestEnvelope {
	readonly type: "request";
	readonly id: string;
	readonly request: Command;
}

export type ClientMessage = ClientHello | RequestEnvelope;

export type ServerEvent =
	| {readonly type: "server_snapshot"; readonly snapshot: ServerSnapshot}
	| {readonly type: "session_snapshot"; readonly snapshot: SessionSnapshot}
	| {
			readonly type: "session_progress";
			readonly sessionId: string;
			readonly progress: TranscriptProgress;
	  }
	| {readonly type: "session_removed"; readonly sessionId: string};

export interface ServerHello {
	readonly type: "hello";
	readonly version: typeof PROTOCOL_VERSION;
	readonly connectionId: string;
	readonly snapshot: ServerSnapshot;
}

export interface ServerHelloError {
	readonly type: "hello_error";
	readonly error: ProtocolError;
}

export type ResponseEnvelope =
	| {
			readonly type: "response";
			readonly id: string;
			readonly ok: true;
			readonly result: CommandResult;
	  }
	| {
			readonly type: "response";
			readonly id: string;
			readonly ok: false;
			readonly error: ProtocolError;
	  };

export interface EventEnvelope {
	readonly type: "event";
	readonly event: ServerEvent;
}

export type ServerMessage = ServerHello | ServerHelloError | ResponseEnvelope | EventEnvelope;
