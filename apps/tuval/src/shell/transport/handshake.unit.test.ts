/**
 * The launch-auth fence (#7556, founder ruling 2026-09-02). Three refusals and one acceptance, all
 * decided from the upgrade request alone — no frame has been read when any of them fires. The last
 * two tests are the leak half of the same ruling: the printed URL carries the token and nothing
 * else secret, and the token itself prints as nothing anywhere a log or a snapshot could take it.
 */

import {Redacted} from "effect";
import {describe, expect, it} from "vitest";
import {
	checkHandshake,
	launchUrl,
	loopbackOrigins,
	mintLaunchToken,
	TOKEN_PARAM,
} from "./handshake.ts";

const token = Redacted.make("a".repeat(64));
const origins = loopbackOrigins(4242);
const target = `/?${TOKEN_PARAM}=${Redacted.value(token)}`;

describe("the attach handshake", () => {
	it("accepts the launch token from a loopback page and from a client sending no Origin", () => {
		expect([
			checkHandshake({url: target, origin: "http://127.0.0.1:4242"}, token, origins),
			checkHandshake({url: target, origin: "http://localhost:4242"}, token, origins),
			checkHandshake({url: target, origin: undefined}, token, origins),
		]).toEqual([{_tag: "Accepted"}, {_tag: "Accepted"}, {_tag: "Accepted"}]);
	});

	it("refuses a missing token, a wrong token, and a non-loopback Origin", () => {
		expect([
			checkHandshake({url: "/", origin: undefined}, token, origins),
			checkHandshake({url: `/?${TOKEN_PARAM}=`, origin: undefined}, token, origins),
			checkHandshake({url: undefined, origin: undefined}, token, origins),
			checkHandshake(
				{url: `/?${TOKEN_PARAM}=${"b".repeat(64)}`, origin: undefined},
				token,
				origins,
			),
			checkHandshake({url: `/?${TOKEN_PARAM}=short`, origin: undefined}, token, origins),
			checkHandshake({url: target, origin: "https://evil.example"}, token, origins),
			checkHandshake({url: target, origin: "http://127.0.0.1:9999"}, token, origins),
		]).toEqual([
			{_tag: "Refused", reason: "missing-token"},
			{_tag: "Refused", reason: "missing-token"},
			{_tag: "Refused", reason: "missing-token"},
			{_tag: "Refused", reason: "wrong-token"},
			{_tag: "Refused", reason: "wrong-token"},
			{_tag: "Refused", reason: "foreign-origin"},
			{_tag: "Refused", reason: "foreign-origin"},
		]);
	});

	it("the Origin is judged before the token, so a foreign page never learns whether its guess was right", () => {
		expect(checkHandshake({url: "/", origin: "https://evil.example"}, token, origins)).toEqual({
			_tag: "Refused",
			reason: "foreign-origin",
		});
	});

	it("the printed launch URL carries the token and nothing else secret", () => {
		const url = new URL(launchUrl({port: 4242, token}));
		expect([url.protocol, url.hostname, url.port, url.pathname]).toEqual([
			"ws:",
			"127.0.0.1",
			"4242",
			"/",
		]);
		expect([...url.searchParams.keys()]).toEqual([TOKEN_PARAM]);
		expect(url.searchParams.get(TOKEN_PARAM)).toBe(Redacted.value(token));
	});

	it("a minted token is fresh per launch and prints as nothing outside that one URL", () => {
		const minted = mintLaunchToken();
		const secret = Redacted.value(minted);
		expect(secret).toHaveLength(64);
		expect(secret).not.toBe(Redacted.value(mintLaunchToken()));
		// A log line, a snapshot, a template — every route out of a value goes through one of these.
		expect([
			String(minted),
			`${minted}`,
			JSON.stringify({token: minted}),
			JSON.stringify([minted]),
		]).toEqual(["<redacted>", "<redacted>", '{"token":"<redacted>"}', '["<redacted>"]']);
	});
});
