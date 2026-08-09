/**
 * The pure capture-plan core — surface-token parsing, preview-URL joining, and
 * the one-record-per-surface plan, asserted without a browser (ADR 0040
 * taxonomy: pure logic → unit).
 */
import {assert, describe, it} from "@effect/vitest";
import {
	buildCapturePlan,
	DEFAULT_VIEWPORT,
	DESKTOP_VIEWPORT,
	joinPreviewUrl,
	MOBILE_VIEWPORT,
	parseSurfaceSpec,
	type Surface,
	surfaceFileName,
} from "./plan.ts";

describe("parseSurfaceSpec", () => {
	it("parses a bare route into route + null state", () => {
		assert.deepStrictEqual(parseSurfaceSpec("/sozluk"), {
			surface: "/sozluk",
			route: "/sozluk",
			state: null,
		});
	});

	it("splits a route:state token on the first colon", () => {
		assert.deepStrictEqual(parseSurfaceSpec("/sozluk:empty"), {
			surface: "/sozluk:empty",
			route: "/sozluk",
			state: "empty",
		});
	});

	it("keeps the raw token as the stable surface id", () => {
		assert.strictEqual(
			parseSurfaceSpec("/pano/abc:focus-visible").surface,
			"/pano/abc:focus-visible",
		);
		assert.strictEqual(parseSurfaceSpec("/pano/abc:focus-visible").route, "/pano/abc");
		assert.strictEqual(parseSurfaceSpec("/pano/abc:focus-visible").state, "focus-visible");
	});

	it("rejects an empty token and a stateless colon", () => {
		assert.throws(() => parseSurfaceSpec(""), /empty --surface/);
		assert.throws(() => parseSurfaceSpec(":empty"), /no route/);
	});
});

describe("joinPreviewUrl", () => {
	it("joins a trailing-slash base with a bare route", () => {
		assert.strictEqual(
			joinPreviewUrl("https://pr-9.web.kamp.us/", "sozluk"),
			"https://pr-9.web.kamp.us/sozluk",
		);
	});

	it("joins a no-slash base with a leading-slash route (no double slash)", () => {
		assert.strictEqual(
			joinPreviewUrl("https://pr-9.web.kamp.us", "/sozluk"),
			"https://pr-9.web.kamp.us/sozluk",
		);
	});

	it("rejects a non-absolute base", () => {
		assert.throws(() => joinPreviewUrl("not-a-url", "/x"), /not a valid absolute URL/);
	});

	it("rejects a non-http(s) base", () => {
		assert.throws(() => joinPreviewUrl("ftp://x.dev", "/x"), /must be http/);
	});
});

describe("surfaceFileName", () => {
	it("derives a filesystem-safe PNG name from route + state + viewport", () => {
		assert.strictEqual(
			surfaceFileName({surface: "/sozluk", route: "/sozluk", state: null}, DESKTOP_VIEWPORT),
			"sozluk@desktop.png",
		);
		assert.strictEqual(
			surfaceFileName(
				{surface: "/sozluk:empty", route: "/sozluk", state: "empty"},
				MOBILE_VIEWPORT,
			),
			"sozluk-empty@mobile.png",
		);
	});

	it("maps the root route to a non-empty name", () => {
		assert.strictEqual(
			surfaceFileName({surface: "/", route: "/", state: null}, DESKTOP_VIEWPORT),
			"root@desktop.png",
		);
	});

	it("collapses non-alnum runs and trims leading/trailing dashes", () => {
		assert.strictEqual(
			surfaceFileName({surface: "s", route: "/a//b??c", state: null}, DESKTOP_VIEWPORT),
			"a-b-c@desktop.png",
		);
	});

	it("sanitizes a pathological uncontrolled route in linear time (no ReDoS)", () => {
		// A long run of non-alnum chars is exactly what made the old `/^-+|-+$/g`
		// trailing-trim backtrack polynomially (CodeQL alert #24). Bounded + linear
		// now: it returns promptly and still yields a dash-trimmed, alnum-only stem.
		const evil = `/${"!".repeat(200_000)}x${"!".repeat(200_000)}`;
		const started = Date.now();
		const name = surfaceFileName({surface: evil, route: evil, state: null}, DESKTOP_VIEWPORT);
		assert.ok(Date.now() - started < 1000, "sanitization must be linear, not polynomial");
		// Clamped to the bounded stem, collapsed to a single dash, dashes trimmed:
		// the pathological prefix is all `!` → one `-` → trimmed to "" → "root".
		assert.strictEqual(name, "root@desktop.png");
		assert.ok(!name.startsWith("-") && !name.includes("-@"), "no leading/trailing dashes survive");
	});
});

describe("buildCapturePlan", () => {
	const surfaces: readonly Surface[] = [
		{surface: "/sozluk", route: "/sozluk", state: null},
		{surface: "/sozluk:empty", route: "/sozluk", state: "empty"},
	];

	it("defaults to the desktop viewport", () => {
		assert.deepStrictEqual(DEFAULT_VIEWPORT, DESKTOP_VIEWPORT);
	});

	it("produces exactly one shot per surface (no viewport cross-product)", () => {
		const plan = buildCapturePlan("https://pr-9.web.kamp.us", surfaces);
		assert.strictEqual(plan.length, surfaces.length);
	});

	it("roots each shot URL at the preview base and carries the surface + file name", () => {
		const plan = buildCapturePlan("https://pr-9.web.kamp.us", surfaces);
		const empty = plan.find((s) => s.surface.surface === "/sozluk:empty");
		assert.strictEqual(empty?.url, "https://pr-9.web.kamp.us/sozluk");
		assert.strictEqual(empty?.surface.state, "empty");
		assert.strictEqual(empty?.fileName, "sozluk-empty@desktop.png");
	});

	it("captures at the mobile viewport when asked", () => {
		const plan = buildCapturePlan("https://x.dev", surfaces, MOBILE_VIEWPORT);
		assert.isTrue(plan.every((s) => s.viewport.label === "mobile"));
	});

	it("gives each shot a distinct on-disk file name", () => {
		const plan = buildCapturePlan("https://x.dev", surfaces);
		const names = plan.map((s) => s.fileName);
		assert.strictEqual(new Set(names).size, names.length);
	});

	it("fails closed on an empty surface set (no silent no-op)", () => {
		assert.throws(() => buildCapturePlan("https://x.dev", []), /no surfaces/);
	});

	it("rejects duplicate surface tokens (on-disk + evidence collision)", () => {
		const dup: readonly Surface[] = [
			{surface: "/x", route: "/x", state: null},
			{surface: "/x", route: "/x", state: null},
		];
		assert.throws(() => buildCapturePlan("https://x.dev", dup), /duplicate surface/);
	});
});
