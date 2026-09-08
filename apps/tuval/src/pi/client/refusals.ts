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
import {retaining} from "../diagnostics.ts";
import {
	type ConnectionRefusal,
	Disconnected,
	ProtocolRefused,
	SessionLocked,
	SessionNotFound,
	type SessionRefusal,
} from "./errors.ts";

const isConnectionLoss = (cause: unknown): boolean =>
	cause instanceof DisconnectedError || cause instanceof ClientDisposedError;

/** The refusal for a call that names no session: connect, reconnect, create. */
export const connectionRefusalOf = (cause: unknown): ConnectionRefusal => {
	if (isConnectionLoss(cause))
		return retaining(cause, new Disconnected({detail: "the Pi connection ended"}));
	if (cause instanceof ServerError) {
		return retaining(
			cause,
			new ProtocolRefused({code: cause.code, detail: "the Pi server refused the request"}),
		);
	}
	return retaining(
		cause,
		new ProtocolRefused({
			code: "internal_error",
			detail: "the Pi client could not complete the request",
		}),
	);
};

/** The refusal for a call that names a session: attach, prompt. */
export const sessionRefusalOf = (sessionId: string, cause: unknown): SessionRefusal => {
	if (cause instanceof ServerError) {
		if (cause.code === "session_locked") {
			return retaining(
				cause,
				new SessionLocked({sessionId, detail: "another connection holds this session"}),
			);
		}
		if (cause.code === "not_found") {
			return retaining(
				cause,
				new SessionNotFound({sessionId, detail: "the Pi server could not find this session"}),
			);
		}
	}
	return connectionRefusalOf(cause);
};
