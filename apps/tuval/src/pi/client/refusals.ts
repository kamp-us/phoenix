/**
 * Folding `Client`'s thrown values into the four typed refusals. Pure and total: every input
 * lands on a refusal, so the service's `Effect.tryPromise` catch never has to guess.
 *
 * The classes come from `@earendil-works/pi-client`'s `errors.ts` at the 0.85.1 pin. The pin's
 * session-ownership and session-detached errors went with its session handle: on protocol 8 a lease
 * is a `SessionTarget` the host issued, so an ownership refusal arrives as a `session_locked`
 * `ServerError` off the wire and a dead lease arrives as the disconnect that killed it.
 */

import {ClientDisposedError, DisconnectedError, ServerError} from "@earendil-works/pi-client";
import {
	type ConnectionRefusal,
	Disconnected,
	ProtocolRefused,
	SessionLocked,
	SessionNotFound,
	type SessionRefusal,
} from "./errors.ts";

const detailOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const isConnectionLoss = (cause: unknown): boolean =>
	cause instanceof DisconnectedError || cause instanceof ClientDisposedError;

/** The refusal for a call that names no session: connect, reconnect, create. */
export const connectionRefusalOf = (cause: unknown): ConnectionRefusal => {
	if (isConnectionLoss(cause)) return new Disconnected({detail: detailOf(cause)});
	if (cause instanceof ServerError) {
		return new ProtocolRefused({code: cause.code, detail: detailOf(cause)});
	}
	return new ProtocolRefused({code: "internal_error", detail: detailOf(cause)});
};

/** The refusal for a call that names a session: attach, prompt. */
export const sessionRefusalOf = (sessionId: string, cause: unknown): SessionRefusal => {
	if (cause instanceof ServerError) {
		if (cause.code === "session_locked") {
			return new SessionLocked({sessionId, detail: detailOf(cause)});
		}
		if (cause.code === "not_found") {
			return new SessionNotFound({sessionId, detail: detailOf(cause)});
		}
	}
	return connectionRefusalOf(cause);
};
