/**
 * The flags console module codec (#2742): parse/apply/serialize the `phoenix_flag_overrides`
 * cookie and the Turkish render decisions — DOM-free, so on/off/clear cookie writes and the row
 * labels are proven without a `document` (the `ban-controls.ts` idiom).
 */
import {describe, expect, it} from "vitest";
import {
	actionButtonLabel,
	applyOverride,
	booleanLabel,
	defaultLabel,
	effectiveLabel,
	effectiveValue,
	encodeOverrideCookieValue,
	FLAG_OVERRIDE_COOKIE,
	overrideLabel,
	overrideOutcomeMessage,
	overrideStateOf,
	parseOverridesFromCookie,
	serializeOverrideCookie,
} from "./flag-overrides";

describe("parseOverridesFromCookie", () => {
	it("returns {} for an absent/empty cookie string", () => {
		expect(parseOverridesFromCookie(undefined)).toEqual({});
		expect(parseOverridesFromCookie("")).toEqual({});
		expect(parseOverridesFromCookie("other=1; another=2")).toEqual({});
	});

	it("decodes the URL-encoded JSON map, picking the cookie out of a multi-cookie string", () => {
		const value = encodeURIComponent(
			JSON.stringify({"pano-draft-save": true, "phoenix-reactions": false}),
		);
		const cookie = `session=abc; ${FLAG_OVERRIDE_COOKIE}=${value}; theme=dark`;
		expect(parseOverridesFromCookie(cookie)).toEqual({
			"pano-draft-save": true,
			"phoenix-reactions": false,
		});
	});

	it("degrades a malformed cookie to {} rather than throwing", () => {
		expect(parseOverridesFromCookie(`${FLAG_OVERRIDE_COOKIE}=not-json`)).toEqual({});
		expect(
			parseOverridesFromCookie(`${FLAG_OVERRIDE_COOKIE}=${encodeURIComponent("[1,2]")}`),
		).toEqual({});
	});

	it("keeps only boolean-valued entries (untrusted input)", () => {
		const value = encodeURIComponent(JSON.stringify({a: true, b: "on", c: 1, d: false}));
		expect(parseOverridesFromCookie(`${FLAG_OVERRIDE_COOKIE}=${value}`)).toEqual({
			a: true,
			d: false,
		});
	});
});

describe("applyOverride — on/off/clear", () => {
	it("sets the key on `on` / `off`", () => {
		expect(applyOverride({}, {key: "f", state: "on"})).toEqual({f: true});
		expect(applyOverride({f: true}, {key: "f", state: "off"})).toEqual({f: false});
	});

	it("removes the key on `clear`", () => {
		expect(applyOverride({f: true, g: false}, {key: "f", state: "clear"})).toEqual({g: false});
	});

	it("clearing an absent key is a no-op", () => {
		expect(applyOverride({g: false}, {key: "f", state: "clear"})).toEqual({g: false});
	});
});

describe("overrideStateOf / effectiveValue", () => {
	it("reads present-true ⇒ on, present-false ⇒ off, absent ⇒ clear", () => {
		expect(overrideStateOf({f: true}, "f")).toBe("on");
		expect(overrideStateOf({f: false}, "f")).toBe("off");
		expect(overrideStateOf({}, "f")).toBe("clear");
	});

	it("effective value is the override when set, else the declared default", () => {
		expect(effectiveValue(false, {f: true}, "f")).toBe(true);
		expect(effectiveValue(true, {f: false}, "f")).toBe(false);
		expect(effectiveValue(false, {}, "f")).toBe(false);
		expect(effectiveValue(true, {}, "f")).toBe(true);
	});
});

describe("serializeOverrideCookie — the write side", () => {
	it("writes a path-scoped, SameSite=Lax cookie whose value round-trips back through the parser", () => {
		const map = {"pano-draft-save": true, "phoenix-user-ban": false};
		const cookie = serializeOverrideCookie(map);
		expect(cookie).toContain(`${FLAG_OVERRIDE_COOKIE}=`);
		expect(cookie).toContain("path=/");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toMatch(/max-age=\d+/);
		// The worker (#2741) reads this same cookie value verbatim — prove it decodes to the map.
		const value = cookie.slice(cookie.indexOf("=") + 1, cookie.indexOf(";"));
		expect(parseOverridesFromCookie(`${FLAG_OVERRIDE_COOKIE}=${value}`)).toEqual(map);
	});

	it("emits a max-age=0 deletion when the map is empty (clearing the last override)", () => {
		const cookie = serializeOverrideCookie({});
		expect(cookie).toContain(`${FLAG_OVERRIDE_COOKIE}=;`);
		expect(cookie).toContain("max-age=0");
	});

	it("mirrors the worker encode (URL-encoded JSON)", () => {
		expect(encodeOverrideCookieValue({f: true})).toBe(
			encodeURIComponent(JSON.stringify({f: true})),
		);
	});
});

describe("render decisions — lowercase Turkish, text-only", () => {
	it("labels booleans, defaults, overrides, and effective values", () => {
		expect(booleanLabel(true)).toBe("açık");
		expect(booleanLabel(false)).toBe("kapalı");
		expect(defaultLabel(false)).toBe("varsayılan: kapalı");
		expect(overrideLabel("on")).toBe("yerel geçersiz kılma: açık");
		expect(overrideLabel("off")).toBe("yerel geçersiz kılma: kapalı");
		expect(overrideLabel("clear")).toBe("yerel geçersiz kılma: yok");
		expect(effectiveLabel(true)).toBe("geçerli değer: açık");
	});

	it("confirms each toggle outcome and names the control", () => {
		expect(overrideOutcomeMessage({key: "pano-draft-save", state: "on"})).toContain(
			"açık olarak geçersiz",
		);
		expect(overrideOutcomeMessage({key: "pano-draft-save", state: "off"})).toContain(
			"kapalı olarak geçersiz",
		);
		expect(overrideOutcomeMessage({key: "pano-draft-save", state: "clear"})).toContain(
			"temizlendi",
		);
		expect(actionButtonLabel("on")).toBe("aç");
		expect(actionButtonLabel("off")).toBe("kapat");
		expect(actionButtonLabel("clear")).toBe("temizle");
	});
});
