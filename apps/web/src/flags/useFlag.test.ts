/**
 * The two pure edges `useFlag` is built on: the fetch-path safe-default wiring
 * (`resolveFlagResponse`) and the synchronous `__BOOT__` member path (`resolveBootFlag`, ADR 0179).
 * Node-tested with no DOM/`fetch` — the hook itself is exercised e2e.
 */
import {describe, expect, it} from "vitest";
import {DECLARED_FLAGS} from "./keys";
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

describe("resolveBootFlag — an empty manifest leaves every flag on the fetch path", () => {
	it.each(DECLARED_FLAGS)("does not resolve $key from a boot payload", ({key}) => {
		expect(resolveBootFlag(undefined, key)).toBeUndefined();
		expect(resolveBootFlag({user: null}, key)).toBeUndefined();
		const payload = {user: null, [key]: true};
		expect(resolveBootFlag(payload, key)).toBeUndefined();
	});
});
