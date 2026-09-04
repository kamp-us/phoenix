/**
 * The upgrade guard. It runs on the raw HTTP upgrade, before a WebSocket exists and therefore
 * before any frame is read, so a refusal is an HTTP status line and a destroyed socket rather
 * than a close frame. Pure over the request's URL and headers so the decision is testable
 * without a socket; the caller writes the response.
 */

import type {Redacted} from "effect";
import {tokenMatches} from "./token.ts";

export type RefusalReason =
	| "missing_token"
	| "bad_token"
	| "non_loopback_host"
	| "non_loopback_origin";

export interface HandshakeRefused {
	readonly _tag: "HandshakeRefused";
	readonly reason: RefusalReason;
	readonly status: 401 | 403;
	/** The HTTP reason phrase written back, and the only thing the client is told. */
	readonly statusText: string;
}

export interface HandshakeAccepted {
	readonly _tag: "HandshakeAccepted";
}

export type HandshakeVerdict = HandshakeAccepted | HandshakeRefused;

export interface UpgradeRequest {
	readonly url: string | undefined;
	readonly headers: {
		readonly host?: string | undefined;
		readonly origin?: string | undefined;
	};
}

const accepted: HandshakeAccepted = {_tag: "HandshakeAccepted"};

const refuse = (
	reason: RefusalReason,
	status: 401 | 403,
	statusText: string,
): HandshakeRefused => ({
	_tag: "HandshakeRefused",
	reason,
	status,
	statusText,
});

/**
 * `::1` arrives bracketed in a `Host` header (`[::1]:4321`) and bare from `URL.hostname`, so both
 * spellings are here. `localhost` is included because a browser resolves it to a loopback address;
 * every other name is refused rather than resolved, since a DNS lookup at handshake time is a
 * rebinding window.
 */
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const hostnameOf = (authority: string): string => {
	if (authority.startsWith("[")) {
		const end = authority.indexOf("]");
		return end === -1 ? authority : authority.slice(0, end + 1);
	}
	const colon = authority.indexOf(":");
	return colon === -1 ? authority : authority.slice(0, colon);
};

const isLoopbackAuthority = (authority: string): boolean =>
	loopbackHosts.has(hostnameOf(authority).toLowerCase());

/**
 * An `Origin` is loopback only when it parses as an http(s)/ws(s) URL on a loopback host. A page
 * with an opaque origin sends the literal `null` and is refused with everything else: the only
 * page meant to reach this server is Tuval's own shell, served over loopback.
 */
const isLoopbackOrigin = (origin: string): boolean => {
	if (!URL.canParse(origin)) return false;
	const parsed = new URL(origin);
	if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return false;
	return loopbackHosts.has(parsed.hostname.toLowerCase());
};

export const authorizeUpgrade = (
	request: UpgradeRequest,
	expected: Redacted.Redacted<string>,
): HandshakeVerdict => {
	const host = request.headers.host;
	if (host === undefined || !isLoopbackAuthority(host)) {
		return refuse("non_loopback_host", 403, "Forbidden - non-loopback Host");
	}

	const origin = request.headers.origin;
	if (origin !== undefined && !isLoopbackOrigin(origin)) {
		return refuse("non_loopback_origin", 403, "Forbidden - non-loopback Origin");
	}

	const presented = new URL(request.url ?? "/", `http://${host}`).searchParams.get("token");
	if (presented === null) return refuse("missing_token", 401, "Unauthorized - missing token");
	if (!tokenMatches(expected, presented)) {
		return refuse("bad_token", 401, "Unauthorized - bad token");
	}

	return accepted;
};

/** The bytes written back on a refusal. No body: the reason phrase is the whole answer. */
export const refusalResponse = (refusal: HandshakeRefused): string =>
	`HTTP/1.1 ${refusal.status} ${refusal.statusText}\r\nConnection: close\r\n\r\n`;

export const isRefused = (verdict: HandshakeVerdict): verdict is HandshakeRefused =>
	verdict._tag === "HandshakeRefused";
