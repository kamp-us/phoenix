/** Pins ADR 0118's invariant: with no `VITE_SENTRY_DSN`, the SPA Sentry wiring is inert. */
import {afterEach, describe, expect, it, vi} from "vitest";

const {init, captureException, setTag} = vi.hoisted(() => ({
	init: vi.fn(),
	captureException: vi.fn(),
	setTag: vi.fn(),
}));
vi.mock("@sentry/react", () => ({init, captureException, setTag}));

// Only the DSN-independent helpers can be imported statically — see `loadInert` below.
import {browserOptions, flagTag, sentryEnabled} from "./sentry";

afterEach(() => {
	vi.clearAllMocks();
	// The DSN stub and the module-registry reset must not leak into sibling tests.
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
	// `sentry.ts` binds its `dsn` at MODULE LOAD, so a statically-imported copy would carry
	// whatever a developer's local `.env` supplies and defeat the invariant (#1656). Stubbing
	// empty + dropping the module cache proves the gate is inert BECAUSE it saw no DSN (#1661).
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
	it("flagTag maps a resolved flag to a queryable flag.<key> tag", () => {
		expect(flagTag("phoenix-bildirim", true)).toEqual({
			tagKey: "flag.phoenix-bildirim",
			tagValue: "on",
		});
		expect(flagTag("member-mute", false)).toEqual({
			tagKey: "flag.member-mute",
			tagValue: "off",
		});
	});

	// Mirrors `loadInert`, with a real DSN so `tagFlag` reads the enabled gate.
	const loadEnabled = async () => {
		vi.stubEnv("VITE_SENTRY_DSN", "https://abc@o0.ingest.de.sentry.io/1");
		vi.resetModules();
		return import("./sentry");
	};

	it("tagFlag sets flag.<key>=on/off on the scope when a DSN is provisioned", async () => {
		const {tagFlag} = await loadEnabled();
		tagFlag("phoenix-bildirim", true);
		expect(setTag).toHaveBeenCalledWith("flag.phoenix-bildirim", "on");
		tagFlag("member-mute", false);
		expect(setTag).toHaveBeenCalledWith("flag.member-mute", "off");
	});
});

describe("decided defaults (ADR 0118)", () => {
	it("browserOptions is pure native dataCollection with no beforeSend", () => {
		const opts = browserOptions("https://abc@o0.ingest.de.sentry.io/1");
		expect(opts.dsn).toBe("https://abc@o0.ingest.de.sentry.io/1");
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
