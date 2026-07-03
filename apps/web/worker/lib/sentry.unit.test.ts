/**
 * Pins ADR 0118's worker-tier invariant (issue #1502): the worker Sentry module is
 * pure options — no init, no client, no network. "Inert when no DSN" is enforced at
 * the request seam (`index.ts`) via the `sentryEnabled` gate this pins; the module
 * itself never touches `@sentry/cloudflare` at runtime. Mirrors the SPA's
 * `src/lib/sentry.unit.test.ts`. Also pins the DSN gate and the PII scrub.
 */
import type {ErrorEvent} from "@sentry/cloudflare";
import * as Cause from "effect/Cause";
import {describe, expect, it} from "vitest";
import {scrubUrls, sentryEnabled, workerOptions} from "./sentry.ts";
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
	it("workerOptions suppresses cookies/headers/user/query PII via native dataCollection", () => {
		const opts = workerOptions("https://abc@o0.ingest.de.sentry.io/1");
		expect(opts.dsn).toBe("https://abc@o0.ingest.de.sentry.io/1");
		// dataCollection is the source of truth; the deprecated `sendDefaultPii` is gone.
		expect(opts.sendDefaultPii).toBeUndefined();
		expect(opts.dataCollection).toEqual({
			userInfo: false,
			cookies: false,
			httpHeaders: {request: false, response: false},
			queryParams: false,
		});
		expect(typeof opts.beforeSend).toBe("function");
	});

	it("scrubUrls strips query strings off the always-sent URL and breadcrumb URLs", () => {
		const event = {
			type: undefined,
			request: {url: "https://kamp.us/reset?token=secret&email=a@b.co"},
			breadcrumbs: [
				{data: {url: "https://kamp.us/api/x?sid=abc"}},
				{data: {from: "/a?q=1", to: "/b?q=2"}},
			],
		} as ErrorEvent;
		const scrubbed = scrubUrls(event);
		expect(scrubbed.request?.url).toBe("https://kamp.us/reset");
		expect(scrubbed.breadcrumbs?.[0]?.data?.url).toBe("https://kamp.us/api/x");
		expect(scrubbed.breadcrumbs?.[1]?.data?.from).toBe("/a");
		expect(scrubbed.breadcrumbs?.[1]?.data?.to).toBe("/b");
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
