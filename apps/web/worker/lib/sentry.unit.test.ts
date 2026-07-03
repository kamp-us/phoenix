/**
 * Pins ADR 0118's worker-tier invariant (issue #1502): the worker Sentry module is
 * pure options — no init, no client, no network. "Inert when no DSN" is enforced at
 * the request seam (`index.ts`) via the `sentryEnabled` gate this pins; the module
 * itself never touches `@sentry/cloudflare` at runtime. Mirrors the SPA's
 * `src/lib/sentry.unit.test.ts`. Also pins the DSN gate and the native-`dataCollection` shape.
 */
import * as Cause from "effect/Cause";
import {describe, expect, it} from "vitest";
import {sentryEnabled, workerOptions} from "./sentry.ts";
import {shouldCaptureCause} from "./sentry-capture.ts";

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

describe("decided defaults (ADR 0118)", () => {
	it("workerOptions is pure native dataCollection with no beforeSend", () => {
		const opts = workerOptions("https://abc@o0.ingest.de.sentry.io/1");
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

describe("shouldCaptureCause — the defects + 5xx policy (ADR 0118)", () => {
	it("captures an unhandled defect (the must-have)", () => {
		expect(shouldCaptureCause(Cause.die(new Error("boom")))).toBe(true);
	});

	it("captures a typed failure (a 5xx crash at this seam)", () => {
		expect(shouldCaptureCause(Cause.fail("db down"))).toBe(true);
	});

	it("captures a cause mixing an interrupt with a real failure", () => {
		expect(
			shouldCaptureCause(
				Cause.fromReasons([...Cause.fail("x").reasons, ...Cause.interrupt().reasons]),
			),
		).toBe(true);
	});

	it("skips a pure client abort (interrupt-only → 499, e.g. SSE disconnect)", () => {
		expect(shouldCaptureCause(Cause.interrupt())).toBe(false);
	});

	it("skips an empty cause", () => {
		expect(shouldCaptureCause(Cause.empty)).toBe(false);
	});
});
