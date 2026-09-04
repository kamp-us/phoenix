/**
 * Who may attach. The kernel mints one random token per launch and prints one URL carrying it; a
 * page sends that token back in the WebSocket handshake, and the upgrade is refused before any
 * frame when the token is missing or wrong, or when a browser offers an `Origin` that is not the
 * kernel's own loopback origin (#7556, founder ruling 2026-09-02).
 *
 * This is not a sandbox and not user auth. One user, one machine: it keeps other pages on the same
 * machine out of a loopback socket that would otherwise answer any of them, which is the whole of
 * what a per-launch token buys. Remote attach needs real credentials and is a later ticket (#7467).
 *
 * The token is a `Redacted` everywhere but the one printed URL: at the pin (rc.112) `Redacted`'s
 * `toString` and `toJSON` both answer `<redacted>`, so a token that reaches a log line or a
 * checkpoint prints as nothing (`effect/Redacted`).
 */

import {randomBytes, timingSafeEqual} from "node:crypto";
import {Redacted} from "effect";
import type {HandshakeRefusal} from "./errors.ts";

/** 32 bytes of `randomBytes`, hex — a per-launch secret, not an identifier anything else may key on. */
export const mintLaunchToken = (): Redacted.Redacted<string> =>
	Redacted.make(randomBytes(32).toString("hex"));

export const TOKEN_PARAM = "token";

/**
 * The loopback origins a browser page served on `port` carries. One launch serves two ports — the
 * socket's and the page server's — so a fence built from the socket's port alone refuses the page
 * it was meant to admit; the launch admits the page's port too, once Vite has listened (#7560).
 */
export const loopbackOrigins = (port: number): ReadonlySet<string> =>
	new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);

/** The one URL the launch prints. The token is its only secret; nothing else on it is one. */
export const launchUrl = (options: {
	readonly port: number;
	readonly token: Redacted.Redacted<string>;
	readonly host?: string;
}): string => {
	const url = new URL(`ws://${options.host ?? "127.0.0.1"}:${options.port}/`);
	url.searchParams.set(TOKEN_PARAM, Redacted.value(options.token));
	return url.toString();
};

export type HandshakeVerdict =
	| {readonly _tag: "Accepted"}
	| {readonly _tag: "Refused"; readonly reason: HandshakeRefusal};

const accepted: HandshakeVerdict = {_tag: "Accepted"};
const refused = (reason: HandshakeRefusal): HandshakeVerdict => ({_tag: "Refused", reason});

/** Constant-time over equal-length inputs; an unequal length is a mismatch without comparing bytes. */
const sameToken = (offered: string, expected: string): boolean => {
	const a = Buffer.from(offered, "utf8");
	const b = Buffer.from(expected, "utf8");
	return a.length === b.length && timingSafeEqual(a, b);
};

/** What an upgrade request carries that this check reads. Anything else on the request is ignored. */
export interface HandshakeRequest {
	/** The request target, as Node hands it to an upgrade handler: a path plus its query. */
	readonly url: string | undefined;
	/**
	 * The `Origin` header, absent for a non-browser client. Absent is allowed and the token alone
	 * gates it; a browser always sends one, which is what makes the present-origin check a fence.
	 */
	readonly origin: string | undefined;
}

/**
 * The token off a request target, or `null` for a target that carries none. `URL.parse` rather than
 * `new URL`, because Node's HTTP parser accepts targets the URL parser rejects — `GET http://[
 * HTTP/1.1` arrives as `req.url === "http://["` — and `ws` calls `verifyClient` synchronously from
 * the server's `upgrade` listener, so a throw here escapes uncaught and takes the whole kernel down
 * on one unauthenticated loopback connection. An unparseable target names no token, which is the
 * closed answer (#7499).
 */
const offeredToken = (url: string | undefined): string | null =>
	URL.parse(url ?? "/", "ws://127.0.0.1")?.searchParams.get(TOKEN_PARAM) ?? null;

export const checkHandshake = (
	request: HandshakeRequest,
	expected: Redacted.Redacted<string>,
	origins: ReadonlySet<string>,
): HandshakeVerdict => {
	if (request.origin !== undefined && !origins.has(request.origin))
		return refused("foreign-origin");
	const offered = offeredToken(request.url);
	if (offered === null || offered === "") return refused("missing-token");
	return sameToken(offered, Redacted.value(expected)) ? accepted : refused("wrong-token");
};
