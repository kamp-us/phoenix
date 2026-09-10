import type {Command, CommandResult, ProtocolError} from "./command.ts";
import type {PROTOCOL_VERSION, ServerSnapshot, SessionDelta, SessionSnapshot} from "./session.ts";
import type {RpcTarget, SessionTarget} from "./target.ts";

/**
 * Tuval's session stream rides one protocol-8 service subscription, under an id fixed here rather
 * than negotiated: both ends of this socket are Tuval's, one connection carries exactly one such
 * stream, and `pi-client`'s `Client` drops a `service_update` whose subscription it does not know,
 * so the id has to be a constant the client can recognise before it has asked for anything.
 */
export const SESSION_SUBSCRIPTION_ID = "tuval.pi.sessions";

/** The service every Tuval command is invoked under inside the envelope's `call`. */
export const SERVICE_ID = "tuval.pi";

/** Must be the first frame sent by a client. Version is an integer, not a coercible string. */
export interface ClientHello {
	readonly type: "hello";
	readonly version: number;
}

export interface RequestEnvelope {
	readonly type: "request";
	readonly id: string;
	readonly target: RpcTarget;
	readonly request: Command;
}

/**
 * Withdraws a request already sent. `pi-client` emits one when a caller's `AbortSignal` fires;
 * Tuval's own cancellation is the `abort` command, which stops a turn rather than a request.
 */
export interface CancelEnvelope {
	readonly type: "cancel";
	readonly id: string;
	readonly target: RpcTarget;
}

export type ClientMessage = ClientHello | RequestEnvelope | CancelEnvelope;

/**
 * A session reaches a viewer as one whole value and then as what each later revision changed:
 * `session_snapshot` on the first subscribe and on a transcript the viewer cannot patch, and
 * `session_delta` for everything in between. A streamed turn signals per token, so the delta is
 * the frame that turn actually rides on (`./delta.ts`).
 */
export type ServerEvent =
	| {readonly type: "server_snapshot"; readonly snapshot: ServerSnapshot}
	| {readonly type: "session_snapshot"; readonly snapshot: SessionSnapshot}
	| {readonly type: "session_delta"; readonly delta: SessionDelta}
	| {readonly type: "session_removed"; readonly sessionId: string};

export interface ServerHello {
	readonly type: "hello";
	readonly version: typeof PROTOCOL_VERSION;
	readonly serverId: string;
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

export interface ServiceEventEnvelope {
	readonly type: "service_update";
	readonly subscriptionId: string;
	readonly update: ServerEvent;
}

/**
 * Names the session route a presentation is on. Tuval's host sends none — its client holds an
 * attachment per session at once and this frame names one — but the codec stays total over what a
 * protocol-8 peer may send.
 */
export interface AttachmentEnvelope {
	readonly type: "attachment";
	readonly attachment: SessionTarget | null;
}

export type ServerMessage =
	| ServerHello
	| ServerHelloError
	| ResponseEnvelope
	| ServiceEventEnvelope
	| AttachmentEnvelope;
