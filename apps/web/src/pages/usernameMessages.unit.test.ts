/**
 * The username choice's copy, graded in BOTH locales (#7534). The rule itself is the server's
 * module — `localRuleMessage` is asserted to agree with `checkUsername`, never to re-implement
 * it, so a rule change reds here rather than drifting the pre-flight silently.
 */
import {describe, expect, it} from "vitest";
import {checkUsername, normalizeUsername} from "../../worker/features/pasaport/username-rule";
import {en} from "../i18n/en";
import type {Translate} from "../i18n/LocaleProvider";
import {tr} from "../i18n/tr";
import {localRuleMessage, messageForCode, usernameMessageKey} from "./usernameMessages";

const CATALOGS: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
	["tr", tr],
	["en", en],
];

function translateWith(catalog: Readonly<Record<string, string>>): Translate {
	return (key) => catalog[key] ?? "";
}

describe("usernameMessageKey — the code→key lookup, locale-free", () => {
	it("names its own key for every code the surface speaks for", () => {
		expect(usernameMessageKey("TOO_SHORT")).toBe("wire.username.TOO_SHORT");
		expect(usernameMessageKey("TOO_LONG")).toBe("wire.username.TOO_LONG");
		expect(usernameMessageKey("INVALID_FORMAT")).toBe("wire.username.INVALID_FORMAT");
		expect(usernameMessageKey("RESERVED")).toBe("wire.username.RESERVED");
		expect(usernameMessageKey("TAKEN")).toBe("wire.username.TAKEN");
		expect(usernameMessageKey("ALREADY_SET")).toBe("wire.username.ALREADY_SET");
	});

	it("collapses a null and any code it does not name to the generic key", () => {
		expect(usernameMessageKey(null)).toBe("wire.username.generic");
		expect(usernameMessageKey("RATE_LIMIT_EXCEEDED")).toBe("wire.username.generic");
		expect(usernameMessageKey("INTERNAL_SERVER_ERROR")).toBe("wire.username.generic");
	});
});

describe.each(CATALOGS)("messageForCode in %s", (_locale, catalog) => {
	const t = translateWith(catalog);

	it("resolves every named code to that locale's line", () => {
		expect(messageForCode(t, "TAKEN")).toBe(catalog["wire.username.TAKEN"]);
		expect(messageForCode(t, "ALREADY_SET")).toBe(catalog["wire.username.ALREADY_SET"]);
		expect(messageForCode(t, "TOO_SHORT")).toBe(catalog["wire.username.TOO_SHORT"]);
	});

	it("shows the one generic line for a failure this surface cannot name", () => {
		expect(messageForCode(t, "INTERNAL_SERVER_ERROR")).toBe(catalog["wire.username.generic"]);
		expect(messageForCode(t, null)).toBe(catalog["wire.username.generic"]);
	});

	it("never returns an empty string", () => {
		expect(messageForCode(t, "TAKEN")).toBeTruthy();
		expect(messageForCode(t, null)).toBeTruthy();
	});
});

describe.each(
	CATALOGS,
)("localRuleMessage in %s — the pre-flight agrees with the rule", (_l, cat) => {
	const t = translateWith(cat);

	it("passes a valid handle", () => {
		expect(localRuleMessage(t, "umut-sirin")).toBeNull();
	});

	it.each([
		"ab",
		"a".repeat(31),
		"Bad_Handle",
		"silinen",
	])("rejects %s with the line its rule code names", (value) => {
		const code = checkUsername(normalizeUsername(value));
		expect(code).not.toBeNull();
		expect(localRuleMessage(t, value)).toBe(cat[usernameMessageKey(code)]);
	});

	it("normalizes before checking, so a padded valid handle passes", () => {
		expect(localRuleMessage(t, "  Umut-Sirin  ")).toBeNull();
	});
});

describe("the two locales differ", () => {
	it("does not ship the Turkish generic line as the English one", () => {
		expect(en["wire.username.generic"]).not.toBe(tr["wire.username.generic"]);
	});
});
