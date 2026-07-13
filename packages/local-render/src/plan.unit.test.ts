import {DESKTOP_VIEWPORT, MOBILE_VIEWPORT, parseSurfaceSpec} from "@kampus/design-capture";
import {describe, expect, it} from "vitest";
import {
	buildLocalShots,
	buildOverrideCookies,
	DEFAULT_LOCAL_BASE,
	FLAG_OVERRIDE_COOKIE,
	LONGEST_EDGE_BUDGET,
	normalizeClip,
	parseFlagOverride,
	parseRegionSpec,
	planCaptureDirective,
	resolveLocalBase,
} from "./plan.ts";

describe("resolveLocalBase", () => {
	it("defaults to the Vite dev origin when omitted or empty", () => {
		expect(resolveLocalBase()).toBe(DEFAULT_LOCAL_BASE);
		expect(resolveLocalBase("")).toBe(DEFAULT_LOCAL_BASE);
	});

	it("accepts loopback origins", () => {
		expect(resolveLocalBase("http://127.0.0.1:1337")).toBe("http://127.0.0.1:1337");
		expect(resolveLocalBase("http://phoenix.localhost:1337")).toBe("http://phoenix.localhost:1337");
	});

	it("refuses a non-http(s) scheme", () => {
		expect(() => resolveLocalBase("ftp://localhost")).toThrow(/http\(s\)/);
	});

	it("refuses a non-loopback host — a local harness never renders a remote origin", () => {
		expect(() => resolveLocalBase("https://kamp.us")).toThrow(/loopback/);
		expect(() => resolveLocalBase("http://example.com:3000")).toThrow(/loopback/);
	});

	it("refuses a malformed URL", () => {
		expect(() => resolveLocalBase("not a url")).toThrow(/valid absolute URL/);
	});
});

describe("buildOverrideCookies", () => {
	it("returns no cookie for an empty override map", () => {
		expect(buildOverrideCookies(DEFAULT_LOCAL_BASE, {})).toEqual([]);
	});

	it("encodes a URL-encoded JSON map the worker's parse decodes (roundtrip)", () => {
		const overrides = {"pano-draft-save": true, "phoenix-flags-probe": false};
		const cookie = buildOverrideCookies(DEFAULT_LOCAL_BASE, overrides)[0]!;
		expect(cookie.name).toBe(FLAG_OVERRIDE_COOKIE);
		expect(cookie.url).toBe(DEFAULT_LOCAL_BASE);
		// mirrors apps/web/.../dev-override.ts decodeOverrides: JSON.parse(decodeURIComponent(value))
		expect(JSON.parse(decodeURIComponent(cookie.value))).toEqual(overrides);
	});
});

describe("normalizeClip", () => {
	it("clamps the origin to the page and the width to the viewport", () => {
		const clip = normalizeClip({x: -10, y: -5, width: 2000, height: 900}, DESKTOP_VIEWPORT);
		expect(clip).toEqual({x: 0, y: 0, width: DESKTOP_VIEWPORT.width, height: 900});
	});

	it("leaves height unclamped — a full page scrolls vertically", () => {
		const clip = normalizeClip({x: 0, y: 0, width: 100, height: 5000}, DESKTOP_VIEWPORT);
		expect(clip.height).toBe(5000);
	});

	it("refuses a non-positive region", () => {
		expect(() => normalizeClip({x: 0, y: 0, width: 0, height: 100}, DESKTOP_VIEWPORT)).toThrow(
			/positive/,
		);
	});

	it("refuses a region off the page width", () => {
		expect(() => normalizeClip({x: 2000, y: 0, width: 100, height: 100}, DESKTOP_VIEWPORT)).toThrow(
			/off the page width/,
		);
	});
});

describe("planCaptureDirective", () => {
	it("no region, desktop viewport ⇒ no crop, no downscale (1280 < 1400 budget)", () => {
		expect(planCaptureDirective(DESKTOP_VIEWPORT)).toEqual({});
	});

	it("a region under budget ⇒ crop, no downscale", () => {
		const d = planCaptureDirective(DESKTOP_VIEWPORT, {
			region: {x: 0, y: 0, width: 800, height: 600},
		});
		expect(d.clip).toEqual({x: 0, y: 0, width: 800, height: 600});
		expect(d.deviceScaleFactor).toBeUndefined();
	});

	it("a region over budget ⇒ crop + downscale factor = budget / longest edge", () => {
		const d = planCaptureDirective(DESKTOP_VIEWPORT, {
			region: {x: 0, y: 0, width: 1000, height: 2800},
		});
		expect(d.clip).toEqual({x: 0, y: 0, width: 1000, height: 2800});
		// longest edge 2800 > 1400 ⇒ 1400/2800 = 0.5
		expect(d.deviceScaleFactor).toBe(0.5);
	});

	it("honors a custom budget", () => {
		const d = planCaptureDirective(DESKTOP_VIEWPORT, {budget: 640});
		// no region ⇒ css longest edge is the viewport width 1280 > 640 ⇒ 0.5
		expect(d.deviceScaleFactor).toBe(0.5);
	});

	it("refuses a non-positive budget", () => {
		expect(() => planCaptureDirective(DESKTOP_VIEWPORT, {budget: 0})).toThrow(/positive/);
	});
});

describe("buildLocalShots", () => {
	it("joins the local base into each shot URL and applies the crop directive", () => {
		const shots = buildLocalShots(
			DEFAULT_LOCAL_BASE,
			[parseSurfaceSpec("/sozluk"), parseSurfaceSpec("/pano:empty")],
			{regions: {"/sozluk": {x: 0, y: 0, width: 800, height: 600}}},
		);
		expect(shots.map((s) => s.url)).toEqual([
			"http://localhost:3000/sozluk",
			"http://localhost:3000/pano",
		]);
		expect(shots[0]!.clip).toEqual({x: 0, y: 0, width: 800, height: 600});
		expect(shots[1]!.clip).toBeUndefined();
	});

	it("shoots at a supplied viewport (mobile)", () => {
		const shots = buildLocalShots(DEFAULT_LOCAL_BASE, [parseSurfaceSpec("/sozluk")], {
			viewport: MOBILE_VIEWPORT,
		});
		expect(shots[0]!.viewport).toEqual(MOBILE_VIEWPORT);
	});

	it("inherits design-capture's empty/duplicate guards", () => {
		expect(() => buildLocalShots(DEFAULT_LOCAL_BASE, [])).toThrow(/no surfaces/);
		expect(() =>
			buildLocalShots(DEFAULT_LOCAL_BASE, [parseSurfaceSpec("/x"), parseSurfaceSpec("/x")]),
		).toThrow(/duplicate/);
	});
});

describe("parseFlagOverride", () => {
	it("parses on/off (and synonyms) to booleans", () => {
		expect(parseFlagOverride("pano-draft-save=on")).toEqual(["pano-draft-save", true]);
		expect(parseFlagOverride("k=off")).toEqual(["k", false]);
		expect(parseFlagOverride("k=true")).toEqual(["k", true]);
		expect(parseFlagOverride("k=0")).toEqual(["k", false]);
	});

	it("refuses a malformed override", () => {
		expect(() => parseFlagOverride("nokey")).toThrow(/on\|off/);
		expect(() => parseFlagOverride("k=maybe")).toThrow(/on\/off/);
		expect(() => parseFlagOverride("=on")).toThrow();
	});
});

describe("parseRegionSpec", () => {
	it("parses a surface=x,y,w,h token", () => {
		expect(parseRegionSpec("/sozluk=0,10,800,600")).toEqual([
			"/sozluk",
			{x: 0, y: 10, width: 800, height: 600},
		]);
	});

	it("refuses a malformed rect", () => {
		expect(() => parseRegionSpec("/sozluk=0,10,800")).toThrow(/four numbers/);
		expect(() => parseRegionSpec("/sozluk=a,b,c,d")).toThrow(/four numbers/);
		expect(() => parseRegionSpec("noeq")).toThrow(/x,y,w,h/);
	});
});

it("documents the default budget", () => {
	expect(LONGEST_EDGE_BUDGET).toBe(1400);
});
