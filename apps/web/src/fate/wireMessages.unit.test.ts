/**
 * Wire-code coverage is already a compile error when broken — `wire.${FateWireCode}` is the
 * catalog's key type — so this pins it at runtime in BOTH locales, which is what closes the
 * #1422 class now that the copy lives in `i18n/{tr,en}/wire.ts`.
 */
import {describe, expect, it} from "vitest";
import {en} from "../i18n/en";
import type {Translate} from "../i18n/LocaleProvider";
import {tr} from "../i18n/tr";
import {FATE_WIRE_CODES, messageForCode, wireMessageKey} from "./wireMessages";

const CATALOGS: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
	["tr", tr],
	["en", en],
];

function translateWith(catalog: Readonly<Record<string, string>>): Translate {
	return (key) => catalog[key] ?? "";
}

describe.each(CATALOGS)("the %s catalog covers every wire code", (_locale, catalog) => {
	it("has a non-empty message for every declared wire code", () => {
		for (const code of FATE_WIRE_CODES) {
			expect(catalog[wireMessageKey(code)], `missing message for ${code}`).toBeTruthy();
		}
	});

	it("declares no wire key outside FATE_WIRE_CODES", () => {
		const declared = Object.keys(catalog).filter(
			(key) => key.startsWith("wire.") && !key.startsWith("wire.username."),
		);
		expect(new Set(declared)).toEqual(new Set(FATE_WIRE_CODES.map(wireMessageKey)));
	});
});

describe.each(CATALOGS)("messageForCode in %s — override wins over the catalog base", (_l, cat) => {
	const t = translateWith(cat);

	it("returns the catalog message when no override is supplied", () => {
		expect(messageForCode(t, "POST_NOT_FOUND")).toBe(cat["wire.POST_NOT_FOUND"]);
	});

	it("returns the surface override for a code it names", () => {
		expect(messageForCode(t, "BODY_REQUIRED", {BODY_REQUIRED: "yorum boş olamaz"})).toBe(
			"yorum boş olamaz",
		);
	});

	it("falls through to the catalog for a code the override map omits", () => {
		expect(messageForCode(t, "TAKEN", {BODY_REQUIRED: "yorum boş olamaz"})).toBe(cat["wire.TAKEN"]);
	});

	it("always resolves to a real message — there is no undefined fallthrough", () => {
		for (const code of FATE_WIRE_CODES) {
			expect(messageForCode(t, code)).toBeTruthy();
		}
	});
});

describe("the two locales differ", () => {
	it("does not ship the Turkish line as the English one", () => {
		expect(en["wire.INTERNAL_SERVER_ERROR"]).not.toBe(tr["wire.INTERNAL_SERVER_ERROR"]);
	});
});
