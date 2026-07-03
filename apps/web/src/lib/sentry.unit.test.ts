/**
 * Pins ADR 0118's load-bearing invariant: the SPA Sentry wiring ships INERT. With no
 * `VITE_SENTRY_DSN`, `initSentry`/`captureBoundaryError` never touch `@sentry/react` and
 * never throw — the integration activates only once the maintainer provisions a DSN. The
 * inert block stubs the DSN empty and imports `./sentry` fresh so the invariant is proven
 * deterministically, independent of a developer's local `apps/web/.env` (#1661). Also pins
 * the DSN gate and the PII scrub.
 */
import type {ErrorEvent} from "@sentry/react";
import {afterEach, describe, expect, it, vi} from "vitest";

const {init, captureException} = vi.hoisted(() => ({init: vi.fn(), captureException: vi.fn()}));
vi.mock("@sentry/react", () => ({init, captureException}));

// The inert block imports `initSentry`/`captureBoundaryError` dynamically (after stubbing the
// DSN), so only the DSN-independent helpers are imported statically here.
import {browserOptions, scrubPii, sentryEnabled} from "./sentry";

afterEach(() => {
	vi.clearAllMocks();
	// The inert block stubs VITE_SENTRY_DSN and resets the module registry; restore both so
	// neither leaks into sibling tests.
	vi.unstubAllEnvs();
	vi.resetModules();
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
	// `sentry.ts` binds `const dsn = import.meta.env.VITE_SENTRY_DSN` at MODULE LOAD, so the
	// static top-of-file import binds `dsn` to whatever ambient `.env` supplies — a provisioned
	// local DSN (#1656) would defeat the invariant. Stub the DSN empty, drop the module cache,
	// and re-import so the fresh evaluation reads the empty stub — proving the gate is inert
	// BECAUSE it saw no DSN, deterministically regardless of `apps/web/.env` (#1661).
	const loadInert = async () => {
		vi.stubEnv("VITE_SENTRY_DSN", "");
		vi.resetModules();
		return import("./sentry");
	};

	it("initSentry does not init and does not throw", async () => {
		const {initSentry} = await loadInert();
		expect(() => initSentry()).not.toThrow();
		expect(init).not.toHaveBeenCalled();
	});

	it("captureBoundaryError does not capture and does not throw", async () => {
		const {captureBoundaryError} = await loadInert();
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
