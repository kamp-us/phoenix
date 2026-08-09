/**
 * The pure deterministic-diff core: determinism (same inputs → same result),
 * masking (dynamic regions excluded — the diff-time flake canon), magnitude, and
 * region clustering. No PNG codec, no network — operates on decoded RGBA rasters
 * (ADR 0040 taxonomy: pure logic → unit; the AC's determinism + masking checks).
 */
import {assert, describe, it} from "@effect/vitest";
import {diffRasters, type RasterImage} from "./golden-diff.ts";

/** A solid `width×height` RGBA raster filled with one color. */
const solid = (
	width: number,
	height: number,
	[r, g, b, a]: readonly [number, number, number, number],
): RasterImage => {
	const pixels = new Uint8Array(width * height * 4);
	for (let p = 0; p < width * height; p++) {
		pixels[p * 4] = r;
		pixels[p * 4 + 1] = g;
		pixels[p * 4 + 2] = b;
		pixels[p * 4 + 3] = a;
	}
	return {width, height, pixels};
};

/** Copy a raster and overwrite one pixel's color — a single localized change. */
const withPixel = (
	image: RasterImage,
	x: number,
	y: number,
	[r, g, b, a]: readonly [number, number, number, number],
): RasterImage => {
	const pixels = new Uint8Array(image.pixels);
	const o = (y * image.width + x) * 4;
	pixels[o] = r;
	pixels[o + 1] = g;
	pixels[o + 2] = b;
	pixels[o + 3] = a;
	return {width: image.width, height: image.height, pixels};
};

const WHITE = [255, 255, 255, 255] as const;
const BLACK = [0, 0, 0, 255] as const;

describe("diffRasters — identical", () => {
	it("reports zero deviation and no regions for identical images", () => {
		const g = solid(4, 4, WHITE);
		const result = diffRasters(g, solid(4, 4, WHITE));
		assert.strictEqual(result.dimensionsMatch, true);
		assert.strictEqual(result.diffPixels, 0);
		assert.strictEqual(result.magnitude, 0);
		assert.strictEqual(result.comparedPixels, 16);
		assert.deepStrictEqual(result.regions, []);
	});
});

describe("diffRasters — determinism", () => {
	it("same inputs → deep-equal result every time", () => {
		const g = solid(6, 6, WHITE);
		const c = withPixel(withPixel(solid(6, 6, WHITE), 1, 1, BLACK), 4, 4, BLACK);
		assert.deepStrictEqual(diffRasters(g, c), diffRasters(g, c));
	});
});

describe("diffRasters — dimension mismatch", () => {
	it("is a whole-surface change: magnitude 1, no regions, dimensionsMatch false", () => {
		const result = diffRasters(solid(4, 4, WHITE), solid(4, 5, WHITE));
		assert.strictEqual(result.dimensionsMatch, false);
		assert.strictEqual(result.magnitude, 1);
		assert.strictEqual(result.comparedPixels, 0);
		assert.deepStrictEqual(result.regions, []);
		// reports the CANDIDATE dimensions (the render under test)
		assert.strictEqual(result.width, 4);
		assert.strictEqual(result.height, 5);
	});
});

describe("diffRasters — masking (the diff-time flake canon)", () => {
	it("excludes masked pixels so a change inside a mask reads as zero deviation", () => {
		const g = solid(4, 4, WHITE);
		const c = withPixel(solid(4, 4, WHITE), 0, 0, BLACK); // the only change is at (0,0)
		const result = diffRasters(g, c, {masks: [{x: 0, y: 0, width: 2, height: 2}]});
		assert.strictEqual(result.diffPixels, 0);
		assert.strictEqual(result.magnitude, 0);
		assert.strictEqual(result.maskedPixels, 4);
		assert.strictEqual(result.comparedPixels, 12);
	});

	it("clamps an out-of-bounds mask to the image", () => {
		const g = solid(2, 2, WHITE);
		const result = diffRasters(g, solid(2, 2, WHITE), {
			masks: [{x: 1, y: 1, width: 99, height: 99}],
		});
		assert.strictEqual(result.maskedPixels, 1);
		assert.strictEqual(result.comparedPixels, 3);
	});
});

describe("diffRasters — magnitude + regions", () => {
	it("a single differing pixel → one 1×1 region and magnitude 1/total", () => {
		const g = solid(4, 4, WHITE);
		const result = diffRasters(g, withPixel(solid(4, 4, WHITE), 2, 3, BLACK));
		assert.strictEqual(result.diffPixels, 1);
		assert.strictEqual(result.magnitude, 1 / 16);
		assert.deepStrictEqual(result.regions, [{x: 2, y: 3, width: 1, height: 1, diffPixels: 1}]);
	});

	it("two separated differing pixels → two distinct regions (4-connected clustering)", () => {
		const g = solid(5, 5, WHITE);
		const c = withPixel(withPixel(solid(5, 5, WHITE), 0, 0, BLACK), 4, 4, BLACK);
		const result = diffRasters(g, c);
		assert.strictEqual(result.regions.length, 2);
		// row-major discovery order: (0,0) before (4,4)
		assert.deepStrictEqual(result.regions[0], {x: 0, y: 0, width: 1, height: 1, diffPixels: 1});
		assert.deepStrictEqual(result.regions[1], {x: 4, y: 4, width: 1, height: 1, diffPixels: 1});
	});

	it("a 2×2 block of adjacent changes clusters into ONE region", () => {
		let c = solid(4, 4, WHITE);
		c = withPixel(c, 1, 1, BLACK);
		c = withPixel(c, 2, 1, BLACK);
		c = withPixel(c, 1, 2, BLACK);
		c = withPixel(c, 2, 2, BLACK);
		const result = diffRasters(solid(4, 4, WHITE), c);
		assert.strictEqual(result.regions.length, 1);
		assert.deepStrictEqual(result.regions[0], {x: 1, y: 1, width: 2, height: 2, diffPixels: 4});
	});
});

describe("diffRasters — channel threshold", () => {
	it("absorbs a sub-threshold per-channel delta (no deviation)", () => {
		const g = solid(3, 3, [100, 100, 100, 255]);
		const c = solid(3, 3, [103, 100, 100, 255]); // +3 on red
		assert.strictEqual(diffRasters(g, c, {channelThreshold: 4}).diffPixels, 0);
		assert.strictEqual(diffRasters(g, c, {channelThreshold: 2}).diffPixels, 9); // over threshold → all differ
	});
});

describe("diffRasters — malformed raster", () => {
	it("throws when the pixel buffer length doesn't match the dimensions", () => {
		const bad: RasterImage = {width: 2, height: 2, pixels: new Uint8Array(4)};
		assert.throws(() => diffRasters(bad, solid(2, 2, WHITE)), /malformed/);
	});
});
