/**
 * The pure capture-plan core — surface × viewport selection and preview-URL
 * joining, asserted without a browser (ADR 0040 taxonomy: pure logic → unit).
 */
import {assert, describe, it} from "@effect/vitest";
import {
	buildCapturePlan,
	DEFAULT_VIEWPORTS,
	DESKTOP_VIEWPORT,
	joinPreviewUrl,
	MOBILE_VIEWPORT,
	type Surface,
} from "./plan.ts";

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

	it("preserves a nested route", () => {
		assert.strictEqual(
			joinPreviewUrl("https://x.dev", "/pano/abc123"),
			"https://x.dev/pano/abc123",
		);
	});

	it("rejects a non-absolute base", () => {
		assert.throws(() => joinPreviewUrl("not-a-url", "/x"), /not a valid absolute URL/);
	});

	it("rejects a non-http(s) base", () => {
		assert.throws(() => joinPreviewUrl("ftp://x.dev", "/x"), /must be http/);
	});
});

describe("buildCapturePlan", () => {
	const surfaces: readonly Surface[] = [
		{label: "sozluk-home", route: "/sozluk"},
		{label: "pano-feed", route: "/pano"},
	];

	it("defaults to the desktop + mobile viewports", () => {
		assert.deepStrictEqual(DEFAULT_VIEWPORTS, [DESKTOP_VIEWPORT, MOBILE_VIEWPORT]);
	});

	it("produces the cross-product of surfaces × viewports", () => {
		const plan = buildCapturePlan("https://pr-9.web.kamp.us", surfaces);
		assert.strictEqual(plan.length, surfaces.length * DEFAULT_VIEWPORTS.length);
	});

	it("labels each shot uniquely as surface@viewport", () => {
		const plan = buildCapturePlan("https://pr-9.web.kamp.us", surfaces);
		const labels = plan.map((s) => s.label);
		assert.deepStrictEqual(new Set(labels).size, labels.length);
		assert.include(labels, "sozluk-home@desktop");
		assert.include(labels, "sozluk-home@mobile");
	});

	it("roots every shot URL at the preview base", () => {
		const plan = buildCapturePlan("https://pr-9.web.kamp.us", surfaces);
		assert.isTrue(plan.every((s) => s.url.startsWith("https://pr-9.web.kamp.us/")));
		const sozluk = plan.find((s) => s.label === "sozluk-home@desktop");
		assert.strictEqual(sozluk?.url, "https://pr-9.web.kamp.us/sozluk");
	});

	it("carries the viewport dimensions onto each shot", () => {
		const plan = buildCapturePlan("https://pr-9.web.kamp.us", surfaces);
		const mobile = plan.find((s) => s.label === "pano-feed@mobile");
		assert.deepStrictEqual(mobile?.viewport, MOBILE_VIEWPORT);
	});

	it("honors an explicit single-viewport list", () => {
		const plan = buildCapturePlan("https://x.dev", surfaces, [DESKTOP_VIEWPORT]);
		assert.strictEqual(plan.length, surfaces.length);
		assert.isTrue(plan.every((s) => s.viewport.label === "desktop"));
	});

	it("fails closed on an empty surface set (no silent no-op)", () => {
		assert.throws(() => buildCapturePlan("https://x.dev", []), /no surfaces/);
	});

	it("fails closed on an empty viewport set", () => {
		assert.throws(() => buildCapturePlan("https://x.dev", surfaces, []), /no viewports/);
	});

	it("rejects duplicate surface labels (attachment-name collision)", () => {
		const dup: readonly Surface[] = [
			{label: "x", route: "/a"},
			{label: "x", route: "/b"},
		];
		assert.throws(() => buildCapturePlan("https://x.dev", dup), /duplicate surface label/);
	});

	it("rejects an empty surface label", () => {
		assert.throws(
			() => buildCapturePlan("https://x.dev", [{label: "", route: "/a"}]),
			/empty label/,
		);
	});
});
