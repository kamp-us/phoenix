/**
 * The `useFlag` response-wiring contract (#1111) — covers the SPA call-site
 * wiring of `resolveFlag` that, before this, only one e2e touched. The pure
 * `resolveFlagResponse` is the load-bearing edge: a hook that forgot to route the
 * server JSON through `resolveFlag`, or dropped the non-2xx guard, ships green
 * past everything but the e2e and would fail here instead.
 *
 * Node-tested with no DOM/`fetch`, per the repo's pure-extraction idiom
 * (`toProfileStatsState` / `useToggleAction.test.ts`); `apps/web/src` has no
 * jsdom/testing-library.
 */
import {describe, expect, it} from "vitest";
import {resolveFlagResponse} from "./useFlag";

describe("resolveFlagResponse — useFlag's safe-default wiring of resolveFlag", () => {
	it("returns the server value when the response is 2xx and the flag is on (the gated path)", () => {
		// Default off, server evaluated it on → the gate flips to the gated path.
		expect(resolveFlagResponse(true, {flags: {"new-ui": true}}, "new-ui", false)).toBe(true);
	});

	it("returns the server value even when it differs from a non-false default", () => {
		expect(resolveFlagResponse(true, {flags: {"kill-switch": false}}, "kill-switch", true)).toBe(
			false,
		);
	});

	it("holds the default on a non-2xx response (the fetch-error path)", () => {
		// A 500/404 must not flip the gate on — the off/old/safe path holds (#488).
		expect(resolveFlagResponse(false, {flags: {"new-ui": true}}, "new-ui", false)).toBe(false);
		expect(resolveFlagResponse(false, null, "new-ui", true)).toBe(true);
	});

	it("holds the default for an undeclared flag (key absent from the response)", () => {
		expect(resolveFlagResponse(true, {flags: {other: true}}, "new-ui", false)).toBe(false);
	});

	it("holds the default when the 2xx body is structurally malformed", () => {
		// The body is untrusted JSON; the resolveFlag guard, not a cast, rejects it.
		expect(resolveFlagResponse(true, null, "new-ui", false)).toBe(false);
		expect(resolveFlagResponse(true, {flags: {"new-ui": "yes"}}, "new-ui", false)).toBe(false);
	});
});
