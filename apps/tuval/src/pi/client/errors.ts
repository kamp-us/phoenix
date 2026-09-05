/**
 * The four refusals this client speaks. Every failure the 0.84.3 `PiClient` throws — its own error
 * classes, a `ProtocolError` off the wire, or anything unrecognised — folds into one of these in
 * [`refusals.ts`](./refusals.ts), so no `Promise` rejection and no Pi error class escapes the
 * service's error channel.
 */

import {Schema} from "effect";

/** The session is held by a lease this client cannot take — another connection's, or its own. */
export class SessionLocked extends Schema.TaggedError<SessionLocked>()(
	"tuval/pi/client/SessionLocked",
	{sessionId: Schema.String, detail: Schema.String},
) {
	override get message(): string {
		return `Pi session ${this.sessionId} is locked: ${this.detail}`;
	}
}

/** The server knows no session under this id. */
export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()(
	"tuval/pi/client/SessionNotFound",
	{sessionId: Schema.String, detail: Schema.String},
) {
	override get message(): string {
		return `Pi session ${this.sessionId} was not found: ${this.detail}`;
	}
}

/**
 * The connection is gone — the socket dropped, the client was disposed, or a lease died with the
 * connection that held it. Reconnecting is the caller's call; this client never does it unasked.
 */
export class Disconnected extends Schema.TaggedError<Disconnected>()(
	"tuval/pi/client/Disconnected",
	{detail: Schema.String},
) {
	override get message(): string {
		return `the Pi connection is closed: ${this.detail}`;
	}
}

/** The server refused under a protocol code, or answered something the protocol does not allow. */
export class ProtocolRefused extends Schema.TaggedError<ProtocolRefused>()(
	"tuval/pi/client/ProtocolRefused",
	{code: Schema.String, detail: Schema.String},
) {
	override get message(): string {
		return `the Pi server refused with "${this.code}": ${this.detail}`;
	}
}

/** Every way a call naming a session can be refused. */
export type SessionRefusal = SessionLocked | SessionNotFound | Disconnected | ProtocolRefused;

/** Every way a call naming no session can be refused. */
export type ConnectionRefusal = Disconnected | ProtocolRefused;
