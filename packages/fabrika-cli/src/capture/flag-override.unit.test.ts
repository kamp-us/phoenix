import {describe, expect, it} from "vitest";
import {
	FLAG_OVERRIDE_COOKIE,
	flagProbeBody,
	NO_FORCED_FLAGS,
	overrideCookies,
	parseFlagOperands,
	readOverrideProof,
} from "./flag-override.ts";

const PREVIEW = "https://pr-4321-web.example.test";

describe("parseFlagOperands", () => {
	it("reads a <key>=<on|off> pair into the value the preview is asked to force", () => {
		expect(parseFlagOperands(["app-welcome=on", "app-flags-probe=off"])).toEqual({
			_tag: "Forced",
			flags: {"app-welcome": true, "app-flags-probe": false},
		});
	});

	it("reads no operands as forcing nothing, which is the ordinary anonymous-default run", () => {
		expect(parseFlagOperands([])).toEqual({_tag: "Forced", flags: {}});
	});

	it.each([
		["app-welcome", "no = separating the key from its value"],
		["=on", '"" is not a flag key'],
		["-app=on", '"-app" is not a flag key'],
		["app welcome=on", '"app welcome" is not a flag key'],
		["app;welcome=on", '"app;welcome" is not a flag key'],
	])("refuses %s rather than guessing at it", (token, reason) => {
		expect(parseFlagOperands([token])).toEqual({_tag: "Malformed", token, reason});
	});

	it.each([
		"true",
		"1",
		"yes",
		"ON",
		"",
	])("refuses %s as a value — the vocabulary is on|off and nothing else", (value) => {
		expect(parseFlagOperands([`app-welcome=${value}`])).toEqual({
			_tag: "Malformed",
			token: `app-welcome=${value}`,
			reason: `"${value}" is not on or off`,
		});
	});

	it("refuses a key forced twice — last-wins would drop an operand nobody hears about", () => {
		expect(parseFlagOperands(["app-welcome=on", "app-welcome=off"])).toEqual({
			_tag: "Malformed",
			token: "app-welcome=off",
			reason: '"app-welcome" is forced more than once',
		});
	});

	it("refuses an unbounded key rather than matching over it", () => {
		const token = `${"a".repeat(129)}=on`;
		expect(parseFlagOperands([token])).toMatchObject({_tag: "Malformed", token});
	});

	it("keeps a value's = intact, so only the first = splits the pair", () => {
		expect(parseFlagOperands(["a=b=on"])).toMatchObject({
			_tag: "Malformed",
			reason: '"b=on" is not on or off',
		});
	});
});

describe("overrideCookies", () => {
	it("writes the worker's wire value, which parseOverrideCookie reads back verbatim", () => {
		const [cookie] = overrideCookies(PREVIEW, {"app-welcome": true});
		expect(cookie).toEqual({
			name: FLAG_OVERRIDE_COOKIE,
			value: encodeURIComponent(JSON.stringify({"app-welcome": true})),
			url: PREVIEW,
			secure: true,
		});
		expect(JSON.parse(decodeURIComponent(cookie?.value ?? ""))).toEqual({
			"app-welcome": true,
		});
	});

	/**
	 * The scoping mechanism, asserted rather than described: no `expires` and no `max-age` makes it a
	 * session cookie in the throwaway context `capture.ts` closes around each shot, and the server
	 * stores nothing — so the override cannot outlive the gate run.
	 */
	it("carries no expiry, so its whole lifetime is the capture context's", () => {
		const [cookie] = overrideCookies(PREVIEW, {"app-welcome": true});
		expect(Object.keys(cookie ?? {}).sort()).toEqual(["name", "secure", "url", "value"]);
	});

	it("drops the secure attribute for an http preview, which Playwright would reject with it", () => {
		expect(overrideCookies("http://localhost:8787", {a: true})[0]?.secure).toBe(false);
	});

	it("seeds nothing when nothing is forced", () => {
		expect(overrideCookies(PREVIEW, NO_FORCED_FLAGS)).toEqual([]);
	});
});

describe("flagProbeBody", () => {
	/**
	 * The opposite value is the whole trick: the evaluate route resolves a key it cannot answer to
	 * the default it was asked with, so a dropped cookie comes back `!forced` for every key.
	 */
	it("asks each forced key with the opposite value as its default", () => {
		expect(JSON.parse(flagProbeBody({a: true, b: false}))).toEqual({
			keys: [
				{key: "a", default: false},
				{key: "b", default: true},
			],
		});
	});
});

describe("readOverrideProof", () => {
	const forced = {"app-welcome": true};
	const body = (flags: Record<string, unknown>) => JSON.stringify({flags});

	it("answers Forced when every key came back at the value it was forced to", () => {
		expect(readOverrideProof(200, body({"app-welcome": true}), forced)).toEqual({
			_tag: "Forced",
		});
	});

	it("names every inert key, not just the first — the caller acts on the whole list", () => {
		expect(
			readOverrideProof(200, body({a: false, b: true, c: false}), {a: true, b: true, c: true}),
		).toEqual({_tag: "Inert", keys: ["a", "c"]});
	});

	it.each([
		[500, body({"app-welcome": true}), "probe answered 500"],
		[200, "not json", "probe body is not JSON"],
		[200, "null", "probe body is not an evaluation object"],
		[200, JSON.stringify({}), "probe body names no flags"],
		[200, body({}), 'probe left "app-welcome" unevaluated'],
		[200, body({"app-welcome": "on"}), 'probe left "app-welcome" unevaluated'],
	])("keeps an unreadable probe UNKNOWN rather than folding it into Inert", (status, raw, reason) => {
		expect(readOverrideProof(status, raw, forced)).toEqual({_tag: "Unreadable", reason});
	});
});
