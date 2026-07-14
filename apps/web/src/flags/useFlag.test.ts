/**
 * The `useFlag` resolution cores — the two pure edges the render-only hook is built on
 * (`apps/web/src` has no jsdom/testing-library, so the hook itself is exercised e2e; these
 * cover the wiring that would otherwise ship green past everything but the e2e).
 *
 * - `resolveFlagResponse` (#1111): the fetch-path safe-default wiring of `resolveFlag` — a
 *   hook that forgot to route the server JSON through `resolveFlag`, or dropped the non-2xx
 *   guard, fails here.
 * - `resolveBootFlag` / `readSignedIn` (#2932, ADR 0179): the synchronous `__BOOT__` member
 *   path — member keys resolve from the injected payload with no fetch, a non-member or an
 *   absent `__BOOT__` returns `undefined` so the hook falls back to fetch, and the `signedIn`
 *   presence bit reads safe-default `false` when `__BOOT__` is absent.
 *
 * Node-tested with no DOM/`fetch`, per the repo's pure-extraction idiom
 * (`toProfileStatsState` / `useToggleAction.test.ts`).
 */
import {afterEach, describe, expect, it} from "vitest";
import {MECMUA_FEED, MECMUA_PUBLIC_READ, PHOENIX_NAV_IA} from "./keys";
import {readSignedIn, resolveBootFlag, resolveFlagResponse} from "./useFlag";

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

describe("resolveBootFlag — the synchronous __BOOT__ member resolution", () => {
	it("returns the injected value for a shell-key-manifest member (no fetch, loading:false)", () => {
		// A member key present in __BOOT__ resolves to its edge-injected value on first render.
		expect(resolveBootFlag({[PHOENIX_NAV_IA]: true}, PHOENIX_NAV_IA)).toBe(true);
		expect(resolveBootFlag({[MECMUA_PUBLIC_READ]: false}, MECMUA_PUBLIC_READ)).toBe(false);
		expect(resolveBootFlag({[MECMUA_FEED]: true}, MECMUA_FEED)).toBe(true);
	});

	it("returns undefined for a member when __BOOT__ is absent (the fetch fallback signal)", () => {
		// The never-hang fallback serves an untransformed asset with no __BOOT__ — the hook must
		// fall back to fetch, so resolution is undefined rather than a crash or a false default.
		expect(resolveBootFlag(undefined, PHOENIX_NAV_IA)).toBeUndefined();
	});

	it("returns undefined for a member key missing from a present __BOOT__ (partial payload)", () => {
		expect(resolveBootFlag({[MECMUA_FEED]: true}, PHOENIX_NAV_IA)).toBeUndefined();
	});

	it("returns undefined for a member whose __BOOT__ value is non-boolean (malformed)", () => {
		expect(resolveBootFlag({[PHOENIX_NAV_IA]: "yes"} as never, PHOENIX_NAV_IA)).toBeUndefined();
	});

	it("returns undefined for a non-member key regardless of __BOOT__ (always the fetch path)", () => {
		// A non-member key never resolves synchronously even if __BOOT__ happens to carry it.
		expect(resolveBootFlag({"pano-draft-save": true} as never, "pano-draft-save")).toBeUndefined();
		expect(resolveBootFlag(undefined, "pano-draft-save")).toBeUndefined();
	});
});

describe("readSignedIn — the synchronous signed-in presence bit", () => {
	afterEach(() => {
		delete (globalThis as {window?: unknown}).window;
	});

	it("reads true from window.__BOOT__.signedIn when signed in", () => {
		(globalThis as {window?: unknown}).window = {__BOOT__: {signedIn: true}};
		expect(readSignedIn()).toBe(true);
	});

	it("reads false from window.__BOOT__.signedIn when signed out", () => {
		(globalThis as {window?: unknown}).window = {__BOOT__: {signedIn: false}};
		expect(readSignedIn()).toBe(false);
	});

	it("safe-defaults to false when __BOOT__ is absent (never-hang fallback / flag off)", () => {
		(globalThis as {window?: unknown}).window = {};
		expect(readSignedIn()).toBe(false);
	});

	it("safe-defaults to false when there is no window at all (never throws)", () => {
		expect(readSignedIn()).toBe(false);
	});
});
