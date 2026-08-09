import {describe, expect, it} from "vitest";
import {CHANNEL_THRESHOLD, diffAgainstGolden, mergeBoxes, REGION_CAP} from "./diff.ts";
import {solid} from "./fakes.test-support.ts";
import type {RasterImage} from "./png.ts";

const image = (width: number, height: number, pixels: Uint8Array): RasterImage => ({
	width,
	height,
	pixels,
});

const withPixel = (
	width: number,
	height: number,
	at: ReadonlyArray<readonly [number, number]>,
	rgba: readonly [number, number, number, number],
): Uint8Array => {
	const pixels = solid(width, height, [0, 0, 0, 255]);
	for (const [x, y] of at) pixels.set(rgba, (y * width + x) * 4);
	return pixels;
};

describe("diffAgainstGolden", () => {
	it("reports a dimension mismatch as maximal signal, and ONLY that shape carries the key", () => {
		const diff = diffAgainstGolden(
			image(2, 2, solid(2, 2, [0, 0, 0, 255])),
			image(2, 3, solid(2, 3, [0, 0, 0, 255])),
		).diff;
		expect(diff).toEqual({magnitude: 1, regions: [], dimensionMismatch: true});
		const matched = diffAgainstGolden(
			image(2, 2, solid(2, 2, [0, 0, 0, 255])),
			image(2, 2, solid(2, 2, [0, 0, 0, 255])),
		).diff;
		expect("dimensionMismatch" in matched).toBe(false);
	});

	it(`ignores a per-channel delta of exactly ${CHANNEL_THRESHOLD} and counts one above it`, () => {
		const golden = image(2, 1, solid(2, 1, [0, 0, 0, 255]));
		const atThreshold = image(2, 1, withPixel(2, 1, [[0, 0]], [CHANNEL_THRESHOLD, 0, 0, 255]));
		const above = image(2, 1, withPixel(2, 1, [[0, 0]], [CHANNEL_THRESHOLD + 1, 0, 0, 255]));
		expect(diffAgainstGolden(golden, atThreshold).diff.magnitude).toBe(0);
		expect(diffAgainstGolden(golden, above).diff.magnitude).toBe(0.5);
	});

	it("rounds magnitude to three decimals", () => {
		const golden = image(3, 1, solid(3, 1, [0, 0, 0, 255]));
		const candidate = image(3, 1, withPixel(3, 1, [[0, 0]], [255, 255, 255, 255]));
		expect(diffAgainstGolden(golden, candidate).diff.magnitude).toBe(0.333);
	});

	it("merges 8-connected differing pixels into one box, largest area first", () => {
		const golden = image(4, 4, solid(4, 4, [0, 0, 0, 255]));
		const candidate = image(
			4,
			4,
			withPixel(
				4,
				4,
				[
					[0, 0],
					[1, 1],
				],
				[255, 255, 255, 255],
			),
		);
		expect(diffAgainstGolden(golden, candidate).diff.regions).toEqual([{x: 0, y: 0, w: 2, h: 2}]);
	});
});

describe("mergeBoxes", () => {
	it("merges boxes within 16px and leaves distant ones alone", () => {
		expect(
			mergeBoxes([
				{x: 0, y: 0, w: 10, h: 10},
				{x: 20, y: 0, w: 10, h: 10},
			]),
		).toEqual([{x: 0, y: 0, w: 30, h: 10}]);
		expect(
			mergeBoxes([
				{x: 0, y: 0, w: 10, h: 10},
				{x: 40, y: 0, w: 10, h: 10},
			]),
		).toHaveLength(2);
	});

	it("merges to a fixpoint — a merge can bring two previously-distant boxes into range", () => {
		expect(
			mergeBoxes([
				{x: 0, y: 0, w: 10, h: 10},
				{x: 60, y: 0, w: 10, h: 10},
				{x: 25, y: 0, w: 20, h: 10},
			]),
		).toEqual([{x: 0, y: 0, w: 70, h: 10}]);
	});
});

describe("the region cap", () => {
	it(`truncates at ${REGION_CAP} regions and reports how many were found`, () => {
		// One differing pixel every 32px: further apart than the 16px merge distance, so each stays
		// its own region and the count crosses the cap.
		const spots = Array.from({length: REGION_CAP + 1}, (_, i) => [i * 32, 0] as const);
		const width = (REGION_CAP + 1) * 32;
		const outcome = diffAgainstGolden(
			image(width, 1, solid(width, 1, [0, 0, 0, 255])),
			image(width, 1, withPixel(width, 1, spots, [255, 255, 255, 255])),
		);
		expect(outcome.found).toBe(REGION_CAP + 1);
		expect(outcome.capped).toBe(true);
		expect(outcome.diff.regions).toHaveLength(REGION_CAP);
	});
});
