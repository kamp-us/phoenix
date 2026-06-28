/**
 * The shared code→message registry (#1421). The load-bearing guarantee is
 * **exhaustiveness**: `WIRE_MESSAGES` covers every `FateWireCode`, so a new code
 * added to `FATE_WIRE_CODES` without a message is a *compile* error — but this
 * test also pins it at runtime so the closure of the #1422 class is asserted, not
 * just type-checked. The `messageForCode` resolution order (override wins over
 * base) is pinned too, since the per-surface copy preservation rides on it.
 */
import {describe, expect, it} from "vitest";
import {FATE_WIRE_CODES, messageForCode, WIRE_MESSAGES} from "./wireMessages";

describe("WIRE_MESSAGES — exhaustive over FateWireCode (closes the #1422 class)", () => {
	it("has a non-empty message for every declared wire code", () => {
		for (const code of FATE_WIRE_CODES) {
			expect(WIRE_MESSAGES[code], `missing base message for ${code}`).toBeTruthy();
		}
	});

	it("declares exactly the codes in FATE_WIRE_CODES — no stray, no missing", () => {
		expect(new Set(Object.keys(WIRE_MESSAGES))).toEqual(new Set(FATE_WIRE_CODES));
	});
});

describe("messageForCode — override wins over the shared base", () => {
	it("returns the base message when no override is supplied", () => {
		expect(messageForCode("POST_NOT_FOUND")).toBe(WIRE_MESSAGES.POST_NOT_FOUND);
	});

	it("returns the surface override for a code it names", () => {
		expect(messageForCode("BODY_REQUIRED", {BODY_REQUIRED: "yorum boş olamaz"})).toBe(
			"yorum boş olamaz",
		);
	});

	it("falls through to the base for a code the override map omits", () => {
		expect(messageForCode("TAKEN", {BODY_REQUIRED: "yorum boş olamaz"})).toBe(WIRE_MESSAGES.TAKEN);
	});

	it("always resolves to a real message — there is no undefined fallthrough", () => {
		for (const code of FATE_WIRE_CODES) {
			expect(typeof messageForCode(code)).toBe("string");
		}
	});
});
