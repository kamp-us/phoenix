/**
 * The client's four refusals → the interface's per-method errors.
 *
 * Founder ruling 3 (#7570) keys an error class to the method that raises it and enumerates the
 * cases inside it, so `SessionLocked`, `SessionNotFound`, `Disconnected` and `Refused` are not
 * tags on this side of the seam — they are `reason`s. This module is the whole translation, so a
 * `tuval/pi/client/*` error never reaches a caller of `TuvalAiAgent`.
 */

import type {AgentFailure} from "../../ai-agent/events.ts";
import {PageError, PromptError, StartError, TransportError} from "../../ai-agent/service/index.ts";
import type {ConnectionRefusal, Disconnected, SessionRefusal} from "../client/index.ts";

export const startErrorOf = (
	cwd: string,
	refusal: SessionRefusal | ConnectionRefusal,
): StartError => {
	switch (refusal._tag) {
		case "tuval/pi/client/SessionNotFound":
			return new StartError({reason: "session-not-found", cwd, detail: refusal.detail});
		case "tuval/pi/client/SessionLocked":
			return new StartError({reason: "session-locked", cwd, detail: refusal.detail});
		case "tuval/pi/client/Disconnected":
			return new StartError({reason: "transport", cwd, detail: refusal.detail});
		case "tuval/pi/client/ProtocolRefused":
			return new StartError({reason: "refused", cwd, detail: `${refusal.code}: ${refusal.detail}`});
	}
};

export const promptErrorOf = (refusal: SessionRefusal): PromptError => {
	switch (refusal._tag) {
		case "tuval/pi/client/SessionNotFound":
			return new PromptError({reason: "no-session", detail: refusal.detail});
		case "tuval/pi/client/Disconnected":
			return new PromptError({reason: "disconnected", detail: refusal.detail});
		// A lease another connection holds refuses this send the same way a protocol code does:
		// the session is there and it said no, which is `refused` rather than `no-session`.
		case "tuval/pi/client/SessionLocked":
			return new PromptError({reason: "refused", detail: refusal.detail});
		case "tuval/pi/client/ProtocolRefused":
			return new PromptError({reason: "refused", detail: `${refusal.code}: ${refusal.detail}`});
	}
};

export const transportErrorOf = (dropped: Disconnected): TransportError =>
	new TransportError({reason: "disconnected", detail: dropped.detail});

/**
 * A refused send, as the plain failure the event stream carries.
 *
 * `prompt` returns at the send (#8018), so by the time the pin refuses one there is no caller left
 * holding a `PromptError` channel and the event stream is the only outbound channel the layer
 * still owns. It rides that stream as a `failure` event rather than failing the queue: the session
 * is still there and the next turn still has to reach the window. Only a lost transport ends the
 * stream, and `transportErrorOf` is the one that does it.
 */
export const promptFailureOf = (refusal: PromptError): AgentFailure => ({
	tag: refusal._tag,
	reason: refusal.reason,
	detail: refusal.message,
});

export const storeUnreadable = (cause: unknown): PageError =>
	new PageError({
		reason: "store-unreadable",
		detail: cause instanceof Error ? cause.message : String(cause),
	});

/**
 * A send refused because the socket is gone, as the terminal failure that ends the event stream.
 *
 * The one refusal that takes the exit `follow` takes on `pi.disconnections`, and for the same
 * reason: nothing dials again, so leaving the stream open would leave a window waiting on a
 * transport that is not coming back. The way back in is another `start({cwd, resume})`.
 */
export const promptDropOf = (refusal: PromptError): TransportError =>
	new TransportError({reason: "disconnected", detail: refusal.detail});
