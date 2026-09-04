import {assert, describe, it} from "@effect/vitest";
import {Redacted} from "effect";
import {authorizeUpgrade, type HandshakeVerdict, isRefused, refusalResponse} from "./handshake.ts";
import {mintCapabilityToken, TOKEN_BYTES, tokenMatches} from "./token.ts";

const token = Redacted.make("a".repeat(64));
const good = `/?token=${Redacted.value(token)}`;

const verdict = (request: {url?: string; host?: string; origin?: string}) =>
	authorizeUpgrade(
		{
			url: request.url ?? good,
			headers: {
				host: request.host ?? "127.0.0.1:4321",
				...(request.origin === undefined ? {} : {origin: request.origin}),
			},
		},
		token,
	);

const refusal = (answer: HandshakeVerdict) => {
	assert.isTrue(isRefused(answer));
	if (!isRefused(answer)) throw new Error("unreachable");
	return {reason: answer.reason, status: answer.status};
};

describe("mintCapabilityToken", () => {
	it("mints 32 random bytes as hex, and a fresh one every call", () => {
		const first = mintCapabilityToken();
		const second = mintCapabilityToken();
		assert.strictEqual(Redacted.value(first).length, TOKEN_BYTES * 2);
		assert.notStrictEqual(Redacted.value(first), Redacted.value(second));
	});

	it("keeps the value out of the string form", () => {
		const minted = mintCapabilityToken();
		assert.notInclude(String(minted), Redacted.value(minted));
	});

	it("compares by value, and refuses a prefix", () => {
		assert.isTrue(tokenMatches(token, Redacted.value(token)));
		assert.isFalse(tokenMatches(token, Redacted.value(token).slice(0, 10)));
		assert.isFalse(tokenMatches(token, `b${Redacted.value(token).slice(1)}`));
	});

	it("refuses a token whose character count matches and whose byte count does not", () => {
		const multibyte = `é${"a".repeat(63)}`;
		assert.strictEqual(multibyte.length, Redacted.value(token).length);
		assert.notStrictEqual(Buffer.byteLength(multibyte), Buffer.byteLength(Redacted.value(token)));
		assert.isFalse(tokenMatches(token, multibyte));
	});
});

describe("authorizeUpgrade", () => {
	it("accepts a loopback host carrying the right token", () => {
		assert.strictEqual(verdict({})._tag, "HandshakeAccepted");
	});

	it("accepts the bracketed IPv6 loopback and localhost", () => {
		assert.strictEqual(verdict({host: "[::1]:4321"})._tag, "HandshakeAccepted");
		assert.strictEqual(verdict({host: "localhost:4321"})._tag, "HandshakeAccepted");
	});

	it("refuses a missing token with 401", () => {
		assert.deepStrictEqual(refusal(verdict({url: "/"})), {reason: "missing_token", status: 401});
	});

	it("answers rather than throws on a loopback hostname whose authority does not parse", () => {
		assert.strictEqual(verdict({host: "127.0.0.1:abc"})._tag, "HandshakeAccepted");
		assert.deepStrictEqual(refusal(verdict({host: "[::1]:abc", url: "/"})), {
			reason: "missing_token",
			status: 401,
		});
	});

	it("refuses an unparseable request target as a missing token", () => {
		assert.deepStrictEqual(refusal(verdict({url: "//["})), {
			reason: "missing_token",
			status: 401,
		});
	});

	it("refuses a wrong token with 401", () => {
		assert.deepStrictEqual(refusal(verdict({url: `/?token=${"b".repeat(64)}`})), {
			reason: "bad_token",
			status: 401,
		});
	});

	it("refuses a percent-decoded multibyte token with 401 rather than throwing", () => {
		assert.deepStrictEqual(refusal(verdict({url: `/?token=%C3%A9${"a".repeat(63)}`})), {
			reason: "bad_token",
			status: 401,
		});
	});

	/**
	 * The class, not the two instances that reached review: nothing an unauthenticated client
	 * controls may throw out of this function, because the caller is a Node `upgrade` listener and
	 * a throw there exits the process pre-auth (#7567).
	 */
	it("answers a verdict for every hostile header and target, never a throw", () => {
		const hostile = [
			{url: `/?token=%C3%A9${"a".repeat(63)}`},
			{url: `/?token=${"%C3%A9".repeat(64)}`},
			{url: "/?token="},
			{url: "//["},
			{url: "http://[::1]:abc/?token=x"},
			{url: "%"},
			{host: "127.0.0.1:abc"},
			{host: "[::1]:abc", url: "/?token=%C3%A9"},
			{host: "["},
			{origin: "http://127.0.0.1:abc"},
			{origin: "%"},
		];
		for (const request of hostile) {
			assert.doesNotThrow(() => verdict(request), JSON.stringify(request));
		}
	});

	it("refuses a non-loopback Host before it even reads the token", () => {
		assert.deepStrictEqual(refusal(verdict({host: "example.com", url: "/"})), {
			reason: "non_loopback_host",
			status: 403,
		});
	});

	it("refuses a non-loopback Origin, and an opaque one", () => {
		assert.deepStrictEqual(refusal(verdict({origin: "https://example.com"})), {
			reason: "non_loopback_origin",
			status: 403,
		});
		assert.deepStrictEqual(refusal(verdict({origin: "null"})), {
			reason: "non_loopback_origin",
			status: 403,
		});
	});

	it("accepts a loopback Origin", () => {
		assert.strictEqual(verdict({origin: "http://127.0.0.1:5173"})._tag, "HandshakeAccepted");
	});

	it("writes the reason phrase back and nothing else", () => {
		const answer = verdict({host: "example.com"});
		if (!isRefused(answer)) throw new Error("expected a refusal");
		assert.strictEqual(
			refusalResponse(answer),
			"HTTP/1.1 403 Forbidden - non-loopback Host\r\nConnection: close\r\n\r\n",
		);
	});
});
