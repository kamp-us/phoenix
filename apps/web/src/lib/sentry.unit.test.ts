/**
 * Pins ADR 0118's load-bearing invariant: the SPA Sentry wiring ships INERT. With no
 * `VITE_SENTRY_DSN` (the default in this test env), `initSentry`/`captureBoundaryError`
 * never touch `@sentry/react` and never throw — the integration activates only once the
 * maintainer provisions a DSN. Also pins the DSN gate and the native-`dataCollection` shape.
 */
import {afterEach, describe, expect, it, vi} from "vitest";

const {init, captureException} = vi.hoisted(() => ({init: vi.fn(), captureException: vi.fn()}));
vi.mock("@sentry/react", () => ({init, captureException}));

import {browserOptions, captureBoundaryError, initSentry, sentryEnabled} from "./sentry";

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
	it("browserOptions is pure native dataCollection with no beforeSend", () => {
		const opts = browserOptions("https://abc@o0.ingest.de.sentry.io/1");
		expect(opts.dsn).toBe("https://abc@o0.ingest.de.sentry.io/1");
		// dataCollection is the whole story; the deprecated `sendDefaultPii` is gone,
		// and no hand-rolled `beforeSend` scrub remains (server-side scrubbing is the backstop).
		expect(opts.sendDefaultPii).toBeUndefined();
		expect(opts.dataCollection).toEqual({
			userInfo: false,
			cookies: false,
			httpHeaders: {request: false, response: false},
			queryParams: false,
		});
		expect(opts.beforeSend).toBeUndefined();
	});
});
