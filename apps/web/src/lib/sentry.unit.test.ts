/**
 * Pins ADR 0118's load-bearing invariant: the SPA Sentry wiring ships INERT. With no
 * `VITE_SENTRY_DSN`, `initSentry`/`captureBoundaryError` never touch `@sentry/react` and
 * never throw — the integration activates only once the maintainer provisions a DSN. The
 * inert block stubs the DSN empty and imports `./sentry` fresh so the invariant is proven
 * deterministically, independent of a developer's local `apps/web/.env` (#1661). Also pins
 * the DSN gate and the native-`dataCollection` shape.
 */
import {afterEach, describe, expect, it, vi} from "vitest";

const {init, captureException, setTag} = vi.hoisted(() => ({
	init: vi.fn(),
	captureException: vi.fn(),
	setTag: vi.fn(),
}));
vi.mock("@sentry/react", () => ({init, captureException, setTag}));

// The inert block imports `initSentry`/`captureBoundaryError`/`tagFlag` dynamically (after stubbing
// the DSN), so only the DSN-independent helpers are imported statically here.
import {browserOptions, flagTag, sentryEnabled} from "./sentry";

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

	it("tagFlag does not tag and does not throw (no scope mutation while inert)", async () => {
		const {tagFlag} = await loadInert();
		expect(() => tagFlag("phoenix-bildirim", true)).not.toThrow();
		expect(setTag).not.toHaveBeenCalled();
	});
});

describe("flag attribution — the tag-naming contract (#1821)", () => {
	// The DSN-independent naming: `flag.<key>` = `on|off`, so a graduation query is `flag.<key>:on`.
	it("flagTag maps a resolved flag to a queryable flag.<key> tag", () => {
		expect(flagTag("phoenix-bildirim", true)).toEqual({
			tagKey: "flag.phoenix-bildirim",
			tagValue: "on",
		});
		expect(flagTag("pano-optimistic-post-delete", false)).toEqual({
			tagKey: "flag.pano-optimistic-post-delete",
			tagValue: "off",
		});
	});

	// With a DSN, a resolved flag lands on the global Sentry scope as a queryable tag. The loader
	// stubs a real DSN + re-imports so `tagFlag` reads the enabled gate (mirrors `loadInert`).
	const loadEnabled = async () => {
		vi.stubEnv("VITE_SENTRY_DSN", "https://abc@o0.ingest.de.sentry.io/1");
		vi.resetModules();
		return import("./sentry");
	};

	it("tagFlag sets flag.<key>=on/off on the scope when a DSN is provisioned", async () => {
		const {tagFlag} = await loadEnabled();
		tagFlag("phoenix-bildirim", true);
		expect(setTag).toHaveBeenCalledWith("flag.phoenix-bildirim", "on");
		tagFlag("pano-optimistic-post-delete", false);
		expect(setTag).toHaveBeenCalledWith("flag.pano-optimistic-post-delete", "off");
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
