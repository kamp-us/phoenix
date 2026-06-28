/**
 * Pins ADR 0118's load-bearing invariant: the SPA Sentry wiring ships INERT. With no
 * `VITE_SENTRY_DSN` (the default in this test env), `initSentry`/`captureBoundaryError`
 * never touch `@sentry/react` and never throw — the integration activates only once the
 * maintainer provisions a DSN. Also pins the DSN gate and the PII scrub.
 */
import type {ErrorEvent} from "@sentry/react";
import {afterEach, describe, expect, it, vi} from "vitest";

const {init, captureException} = vi.hoisted(() => ({init: vi.fn(), captureException: vi.fn()}));
vi.mock("@sentry/react", () => ({init, captureException}));

import {browserOptions, captureBoundaryError, initSentry, scrubPii, sentryEnabled} from "./sentry";

afterEach(() => {
	vi.clearAllMocks();
});

describe("sentryEnabled — the inert gate", () => {
	it("is false for absent/empty/whitespace DSN", () => {
		expect(sentryEnabled(undefined)).toBe(false);
		expect(sentryEnabled("")).toBe(false);
		expect(sentryEnabled("   ")).toBe(false);
	});

	it("is true for a real DSN", () => {
		expect(sentryEnabled("https://abc@o0.ingest.de.sentry.io/1")).toBe(true);
	});
});

describe("inert without a DSN (the whole point of ADR 0118's parked-provisioning ship)", () => {
	// The test env defines no `VITE_SENTRY_DSN`, so the module-level read is undefined.
	it("initSentry does not init and does not throw", () => {
		expect(() => initSentry()).not.toThrow();
		expect(init).not.toHaveBeenCalled();
	});

	it("captureBoundaryError does not capture and does not throw", () => {
		expect(() => captureBoundaryError(new Error("boom"), "  at X")).not.toThrow();
		expect(captureException).not.toHaveBeenCalled();
	});
});

describe("decided defaults (ADR 0118)", () => {
	it("browserOptions disables default PII and wires the scrub", () => {
		const opts = browserOptions("https://abc@o0.ingest.de.sentry.io/1");
		expect(opts.dsn).toBe("https://abc@o0.ingest.de.sentry.io/1");
		expect(opts.sendDefaultPii).toBe(false);
		expect(typeof opts.beforeSend).toBe("function");
	});

	it("scrubPii strips the user block and request cookies/headers", () => {
		const event: ErrorEvent = {
			type: undefined,
			user: {id: "u1", email: "a@b.co"},
			request: {url: "/x", cookies: {sid: "secret"}, headers: {authorization: "Bearer t"}},
		};
		const scrubbed = scrubPii(event);
		expect(scrubbed.user).toEqual({});
		expect(scrubbed.request?.cookies).toBeUndefined();
		expect(scrubbed.request?.headers).toBeUndefined();
	});
});
