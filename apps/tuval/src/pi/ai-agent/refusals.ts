/**
 * The client's four refusals → the interface's per-method errors.
 *
 * Founder ruling 3 (#7570) keys an error class to the method that raises it and enumerates the
 * cases inside it, so `SessionLocked`, `SessionNotFound`, `Disconnected` and `Refused` are not
 * tags on this side of the seam — they are `reason`s. This module is the whole translation, so a
 * `tuval/pi/client/*` error never reaches a caller of `TuvalAiAgent`.
 */

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

export const storeUnreadable = (cause: unknown): PageError =>
	new PageError({
		reason: "store-unreadable",
		detail: cause instanceof Error ? cause.message : String(cause),
	});
