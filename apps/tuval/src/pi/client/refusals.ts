/**
 * Folding `PiClient`'s thrown values into the four typed refusals. Pure and total: every input
 * lands on a refusal, so the service's `Effect.tryPromise` catch never has to guess.
 *
 * The classes come from `@earendil-works/pi-client`'s `errors.ts` at the 0.84.3 pin, and the codes
 * from `@earendil-works/pi-protocol`'s `ProtocolErrorCodeSchema` — `session_locked` and
 * `not_found` are the two this client names; the rest stay protocol refusals under their own code.
 */

import {
	PiClientDisposedError,
	PiDisconnectedError,
	PiServerError,
	PiSessionDetachedError,
	PiSessionOwnershipError,
} from "@earendil-works/pi-client";
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

/**
 * A lease dies with the connection that held it (`client.js` invalidates every lease on a
 * `disconnected` state change), so a detached lease is the drop reaching the caller, not a
 * separate condition.
 */
const isConnectionLoss = (cause: unknown): boolean =>
	cause instanceof PiDisconnectedError ||
	cause instanceof PiClientDisposedError ||
	cause instanceof PiSessionDetachedError;

/** The refusal for a call that names no session: connect, reconnect, create. */
export const connectionRefusalOf = (cause: unknown): ConnectionRefusal => {
	if (isConnectionLoss(cause)) return new Disconnected({detail: detailOf(cause)});
	if (cause instanceof PiServerError) {
		return new ProtocolRefused({code: cause.code, detail: detailOf(cause)});
	}
	return new ProtocolRefused({code: "internal_error", detail: detailOf(cause)});
};

/** The refusal for a call that names a session: attach, prompt. */
export const sessionRefusalOf = (sessionId: string, cause: unknown): SessionRefusal => {
	if (cause instanceof PiSessionOwnershipError) {
		return new SessionLocked({sessionId: cause.sessionId, detail: detailOf(cause)});
	}
	if (cause instanceof PiServerError) {
		if (cause.code === "session_locked") {
			return new SessionLocked({sessionId, detail: detailOf(cause)});
		}
		if (cause.code === "not_found") {
			return new SessionNotFound({sessionId, detail: detailOf(cause)});
		}
	}
	return connectionRefusalOf(cause);
};
