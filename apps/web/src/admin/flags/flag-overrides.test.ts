import {describe, expect, it} from "vitest";
import {
	actionButtonLabelKey,
	applyOverride,
	defaultLabelKey,
	effectiveLabelKey,
	effectiveValue,
	encodeOverrideCookieValue,
	FLAG_OVERRIDE_COOKIE,
	overrideLabelKey,
	overrideOutcomeKey,
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
			JSON.stringify({"mecmua-write": true, "phoenix-reactions": false}),
		);
		const cookie = `session=abc; ${FLAG_OVERRIDE_COOKIE}=${value}; theme=dark`;
		expect(parseOverridesFromCookie(cookie)).toEqual({
			"mecmua-write": true,
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
		const map = {"mecmua-write": true, "phoenix-user-ban": false};
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

// The panel resolves these through `useT`, so the module's job is the key, not the copy.
describe("render decisions — the catalog key each state picks", () => {
	it("keys defaults, overrides, and effective values", () => {
		expect(defaultLabelKey(true)).toBe("admin.flags.default.on");
		expect(defaultLabelKey(false)).toBe("admin.flags.default.off");
		expect(overrideLabelKey("on")).toBe("admin.flags.override.on");
		expect(overrideLabelKey("off")).toBe("admin.flags.override.off");
		expect(overrideLabelKey("clear")).toBe("admin.flags.override.clear");
		expect(effectiveLabelKey(true)).toBe("admin.flags.effective.on");
		expect(effectiveLabelKey(false)).toBe("admin.flags.effective.off");
	});

	it("keys each toggle outcome and each control", () => {
		expect(overrideOutcomeKey("on")).toBe("admin.flags.outcome.on");
		expect(overrideOutcomeKey("off")).toBe("admin.flags.outcome.off");
		expect(overrideOutcomeKey("clear")).toBe("admin.flags.outcome.clear");
		expect(actionButtonLabelKey("on")).toBe("admin.flags.action.on");
		expect(actionButtonLabelKey("off")).toBe("admin.flags.action.off");
		expect(actionButtonLabelKey("clear")).toBe("admin.flags.action.clear");
	});
});
