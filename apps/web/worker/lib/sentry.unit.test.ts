/**
 * Pins ADR 0118's worker-tier invariant (issue #1502): the worker Sentry module ships pure
 * options + the flag-attribution tagger — no init, no client of its own. "Inert when no DSN" is
 * enforced at the request seam (`index.ts`), where `wrapRequestHandler` runs only with a DSN; the
 * module's own `tagFlag` gates on `Sentry.isEnabled()`, which is false without an active client.
 * Mirrors the SPA's `src/lib/sentry.unit.test.ts`. Also pins the DSN gate, the
 * native-`dataCollection` shape, and the worker half of the #1821 `flag.<key>`:`on`/`off` tagging.
 */
import * as Cause from "effect/Cause";
import {afterEach, describe, expect, it, vi} from "vitest";

// `@sentry/cloudflare` is stubbed so `tagFlag` can be driven across the inert (`isEnabled=false`)
// and active (`isEnabled=true`) branches without a real client init — mirrors the SPA test's
// `@sentry/react` mock. Hoisted so the module under test binds these fns at import.
const {isEnabled, setTag} = vi.hoisted(() => ({
	isEnabled: vi.fn(() => false),
	setTag: vi.fn(),
}));
vi.mock("@sentry/cloudflare", () => ({isEnabled, setTag}));

import {sentryEnabled, tagFlag, workerOptions} from "./sentry.ts";
import {shouldCaptureCause} from "./sentry-capture.ts";

afterEach(() => {
	vi.clearAllMocks();
	isEnabled.mockReturnValue(false);
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

describe("tagFlag — worker-tier flag attribution (#1821)", () => {
	it("does not tag and does not throw when Sentry is inert (no active client)", () => {
		isEnabled.mockReturnValue(false);
		expect(() => tagFlag("phoenix-bildirim", true)).not.toThrow();
		expect(setTag).not.toHaveBeenCalled();
	});

	it("sets flag.<key>=on/off on the scope when a client is active", () => {
		isEnabled.mockReturnValue(true);
		tagFlag("phoenix-bildirim", true);
		expect(setTag).toHaveBeenCalledWith("flag.phoenix-bildirim", "on");
		tagFlag("pano-optimistic-post-delete", false);
		expect(setTag).toHaveBeenCalledWith("flag.pano-optimistic-post-delete", "off");
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
