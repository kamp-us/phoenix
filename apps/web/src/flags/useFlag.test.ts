/**
 * The two pure edges `useFlag` is built on: the fetch-path safe-default wiring
 * (`resolveFlagResponse`) and the synchronous `__BOOT__` member path (`resolveBootFlag`, ADR 0179).
 * Node-tested with no DOM/`fetch` — the hook itself is exercised e2e.
 */
import {describe, expect, it} from "vitest";
import {MECMUA_FEED, MECMUA_PUBLIC_READ} from "./keys";
import {resolveBootFlag, resolveFlagResponse} from "./useFlag";

describe("resolveFlagResponse — useFlag's safe-default wiring of resolveFlag", () => {
	it("returns the server value when the response is 2xx and the flag is on (the gated path)", () => {
		expect(resolveFlagResponse(true, {flags: {"new-ui": true}}, "new-ui", false)).toBe(true);
	});

	it("returns the server value even when it differs from a non-false default", () => {
		expect(resolveFlagResponse(true, {flags: {"kill-switch": false}}, "kill-switch", true)).toBe(
			false,
		);
	});

	it("holds the default on a non-2xx response (the fetch-error path)", () => {
		expect(resolveFlagResponse(false, {flags: {"new-ui": true}}, "new-ui", false)).toBe(false);
		expect(resolveFlagResponse(false, null, "new-ui", true)).toBe(true);
	});

	it("holds the default for an undeclared flag (key absent from the response)", () => {
		expect(resolveFlagResponse(true, {flags: {other: true}}, "new-ui", false)).toBe(false);
	});

	it("holds the default when the 2xx body is structurally malformed", () => {
		expect(resolveFlagResponse(true, null, "new-ui", false)).toBe(false);
		expect(resolveFlagResponse(true, {flags: {"new-ui": "yes"}}, "new-ui", false)).toBe(false);
	});
});

describe("resolveBootFlag — the synchronous __BOOT__ member resolution", () => {
	it("returns the injected value for a shell-key-manifest member (no fetch, loading:false)", () => {
		expect(resolveBootFlag({[MECMUA_PUBLIC_READ]: true}, MECMUA_PUBLIC_READ)).toBe(true);
		expect(resolveBootFlag({[MECMUA_PUBLIC_READ]: false}, MECMUA_PUBLIC_READ)).toBe(false);
		expect(resolveBootFlag({[MECMUA_FEED]: true}, MECMUA_FEED)).toBe(true);
	});

	it("returns undefined for a member when __BOOT__ is absent (the fetch fallback signal)", () => {
		expect(resolveBootFlag(undefined, MECMUA_PUBLIC_READ)).toBeUndefined();
	});

	it("returns undefined for a member key missing from a present __BOOT__ (partial payload)", () => {
		expect(resolveBootFlag({[MECMUA_FEED]: true}, MECMUA_PUBLIC_READ)).toBeUndefined();
	});

	it("returns undefined for a member whose __BOOT__ value is non-boolean (malformed)", () => {
		expect(
			resolveBootFlag({[MECMUA_PUBLIC_READ]: "yes"} as never, MECMUA_PUBLIC_READ),
		).toBeUndefined();
	});

	it("returns undefined for a non-member key regardless of __BOOT__ (always the fetch path)", () => {
		expect(resolveBootFlag({"mecmua-write": true} as never, "mecmua-write")).toBeUndefined();
		expect(resolveBootFlag(undefined, "mecmua-write")).toBeUndefined();
	});
});
