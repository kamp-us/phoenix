/**
 * Unit coverage for the dev-only flag-override codec (#622) — the pure cookie
 * parse/serialize + tri-state apply that the dev settings route and the override
 * `Flags` wrapper rest on. No worker, no binding, no DOM: just the codec contract.
 *
 * The codec carries NO environment gate (that lives at the two install sites,
 * `makeRequestFlagsContext` + `http/app.ts`); these tests cover the parse/apply
 * surface, the malformed-input degrade-safe behavior, and the round-trip.
 */
import {describe, expect, it} from "vitest";
import {
	applyOverride,
	emptyOverrides,
	encodeOverrideCookieValue,
	FLAG_OVERRIDE_COOKIE,
	parseOverrideAction,
	parseOverrideCookie,
} from "./dev-override.ts";

const cookie = (value: string) => `${FLAG_OVERRIDE_COOKIE}=${value}`;

describe("parseOverrideCookie", () => {
	it("returns no overrides for an absent header", () => {
		expect(parseOverrideCookie(null)).toEqual(emptyOverrides);
		expect(parseOverrideCookie(undefined)).toEqual(emptyOverrides);
		expect(parseOverrideCookie("")).toEqual(emptyOverrides);
	});

	it("returns no overrides when the cookie is absent from the header", () => {
		expect(parseOverrideCookie("other=1; another=2")).toEqual(emptyOverrides);
	});

	it("parses a well-formed boolean override map", () => {
		const value = encodeOverrideCookieValue({"mecmua-write": true, "demo-flag": false});
		expect(parseOverrideCookie(cookie(value))).toEqual({
			"mecmua-write": true,
			"demo-flag": false,
		});
	});

	it("reads the override cookie out of a multi-cookie header", () => {
		const value = encodeOverrideCookieValue({"x-flag": true});
		expect(parseOverrideCookie(`session=abc; ${cookie(value)}; theme=dark`)).toEqual({
			"x-flag": true,
		});
	});

	it("drops non-boolean entries — only booleans survive", () => {
		const value = encodeURIComponent(JSON.stringify({a: true, b: "yes", c: 1, d: null}));
		expect(parseOverrideCookie(cookie(value))).toEqual({a: true});
	});

	it("degrades to no overrides on a malformed (non-JSON) cookie", () => {
		expect(parseOverrideCookie(cookie("not%20json"))).toEqual(emptyOverrides);
	});

	it("degrades to no overrides on a non-object JSON payload", () => {
		expect(parseOverrideCookie(cookie(encodeURIComponent("[1,2,3]")))).toEqual(emptyOverrides);
		expect(parseOverrideCookie(cookie(encodeURIComponent('"a string"')))).toEqual(emptyOverrides);
	});
});

describe("applyOverride", () => {
	it("forces a flag on", () => {
		expect(applyOverride(emptyOverrides, {key: "f", state: "on"})).toEqual({f: true});
	});

	it("forces a flag off", () => {
		expect(applyOverride(emptyOverrides, {key: "f", state: "off"})).toEqual({f: false});
	});

	it("clear removes the key, leaving the rest", () => {
		expect(applyOverride({f: true, g: false}, {key: "f", state: "clear"})).toEqual({g: false});
	});

	it("clear on an absent key is a no-op", () => {
		expect(applyOverride({g: false}, {key: "f", state: "clear"})).toEqual({g: false});
	});

	it("does not mutate the input map", () => {
		const input = {f: true};
		applyOverride(input, {key: "g", state: "on"});
		expect(input).toEqual({f: true});
	});
});

describe("parseOverrideAction", () => {
	it("parses a valid key/state pair for each tri-state", () => {
		for (const state of ["on", "off", "clear"] as const) {
			expect(parseOverrideAction(new URLSearchParams({key: "f", state}))).toEqual({
				key: "f",
				state,
			});
		}
	});

	it("rejects a missing or empty key", () => {
		expect(parseOverrideAction(new URLSearchParams({state: "on"}))).toBeNull();
		expect(parseOverrideAction(new URLSearchParams({key: "", state: "on"}))).toBeNull();
	});

	it("rejects an unknown state", () => {
		expect(parseOverrideAction(new URLSearchParams({key: "f", state: "maybe"}))).toBeNull();
		expect(parseOverrideAction(new URLSearchParams({key: "f"}))).toBeNull();
	});
});

describe("override cookie round-trip", () => {
	it("encode → parse is identity for a boolean map", () => {
		const map = {"mecmua-write": true, "phoenix-flags-probe": false};
		expect(parseOverrideCookie(cookie(encodeOverrideCookieValue(map)))).toEqual(map);
	});
});
