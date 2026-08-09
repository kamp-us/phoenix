/**
 * The candidate-vs-golden raster diff, defined so two implementers compute **one number**.
 *
 * Every constant here is the contract's, not a taste call: a pixel differs when the max absolute
 * per-channel RGBA delta exceeds {@link CHANNEL_THRESHOLD}; `magnitude` is differing pixels over
 * total pixels rounded to three decimals; regions are the bounding boxes of 8-connected components,
 * merged when they sit within {@link MERGE_DISTANCE}, largest area first, capped at {@link REGION_CAP}.
 *
 * It computes a number and nothing else — see `./golden-verb.ts` for why that is the ceiling.
 *
 * The sibling `../capture/golden-diff.ts` computes a *different* number for the review side — masks,
 * 4-connectivity, an uncapped region list — so this is a second implementation on purpose rather
 * than a reuse missed: the build-side numbers are pinned by this contract and may not drift with it.
 */
import type {RasterImage} from "./png.ts";

/** A pixel differs when the max per-channel absolute delta exceeds this. */
export const CHANNEL_THRESHOLD = 10;
/** Boxes closer than this (in either axis) are one region. */
export const MERGE_DISTANCE = 16;
/** At most this many regions are reported; hitting the cap is stated on stderr. */
export const REGION_CAP = 20;

/** A differing region's bounding box, in the contract's `w`/`h` spelling. */
export interface DiffBox {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

/** The diff object exactly as it appears in a `ui golden` answer. */
export type UiDiff =
	| {readonly magnitude: number; readonly regions: ReadonlyArray<DiffBox>}
	| {
			readonly magnitude: 1;
			readonly regions: ReadonlyArray<never>;
			readonly dimensionMismatch: true;
	  };

export interface DiffOutcome {
	readonly diff: UiDiff;
	/** Whether the region list was truncated at {@link REGION_CAP}. */
	readonly capped: boolean;
	/** Regions found before the cap — what the stderr note reports. */
	readonly found: number;
}

const gap = (aLow: number, aHigh: number, bLow: number, bHigh: number): number =>
	aHigh < bLow ? bLow - aHigh : bHigh < aLow ? aLow - bHigh : 0;

const touching = (a: DiffBox, b: DiffBox): boolean =>
	gap(a.x, a.x + a.w - 1, b.x, b.x + b.w - 1) <= MERGE_DISTANCE &&
	gap(a.y, a.y + a.h - 1, b.y, b.y + b.h - 1) <= MERGE_DISTANCE;

const union = (a: DiffBox, b: DiffBox): DiffBox => {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {
		x,
		y,
		w: Math.max(a.x + a.w, b.x + b.w) - x,
		h: Math.max(a.y + a.h, b.y + b.h) - y,
	};
};

/** Merge to a fixpoint: a merge can bring two previously-distant boxes within range. */
export const mergeBoxes = (boxes: ReadonlyArray<DiffBox>): ReadonlyArray<DiffBox> => {
	const merged: DiffBox[] = [...boxes];
	let changed = true;
	while (changed) {
		changed = false;
		outer: for (let i = 0; i < merged.length; i++) {
			for (let j = i + 1; j < merged.length; j++) {
				const a = merged[i] as DiffBox;
				const b = merged[j] as DiffBox;
				if (!touching(a, b)) continue;
				merged.splice(j, 1);
				merged[i] = union(a, b);
				changed = true;
				break outer;
			}
		}
	}
	return merged;
};

/** 8-connected components of the differing-pixel mask, as bounding boxes. */
const components = (width: number, height: number, differs: Uint8Array): DiffBox[] => {
	const visited = new Uint8Array(width * height);
	const boxes: DiffBox[] = [];
	const stack: number[] = [];
	for (let start = 0; start < differs.length; start++) {
		if (differs[start] === 0 || visited[start] === 1) continue;
		let minX = width;
		let minY = height;
		let maxX = -1;
		let maxY = -1;
		stack.push(start);
		visited[start] = 1;
		while (stack.length > 0) {
			const idx = stack.pop() as number;
			const x = idx % width;
			const y = (idx - x) / width;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx;
					const ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
					const n = ny * width + nx;
					if (differs[n] === 1 && visited[n] === 0) {
						visited[n] = 1;
						stack.push(n);
					}
				}
			}
		}
		boxes.push({x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1});
	}
	return boxes;
};

/**
 * Compute the contract's diff. A dimension mismatch short-circuits to maximal signal — the only
 * honest comparison when the grids do not align — and is the **one** shape carrying
 * `dimensionMismatch`, so its presence is a reliable discriminator rather than a flag to test.
 */
export const diffAgainstGolden = (golden: RasterImage, candidate: RasterImage): DiffOutcome => {
	if (golden.width !== candidate.width || golden.height !== candidate.height) {
		return {
			diff: {magnitude: 1, regions: [], dimensionMismatch: true},
			capped: false,
			found: 0,
		};
	}
	const {width, height} = candidate;
	const differs = new Uint8Array(width * height);
	let count = 0;
	for (let p = 0; p < width * height; p++) {
		const o = p * 4;
		const dr = Math.abs((golden.pixels[o] as number) - (candidate.pixels[o] as number));
		const dg = Math.abs((golden.pixels[o + 1] as number) - (candidate.pixels[o + 1] as number));
		const db = Math.abs((golden.pixels[o + 2] as number) - (candidate.pixels[o + 2] as number));
		const da = Math.abs((golden.pixels[o + 3] as number) - (candidate.pixels[o + 3] as number));
		if (Math.max(dr, dg, db, da) > CHANNEL_THRESHOLD) {
			differs[p] = 1;
			count++;
		}
	}
	const total = width * height;
	const regions = [...mergeBoxes(components(width, height, differs))].sort(
		(a, b) => b.w * b.h - a.w * a.h,
	);
	return {
		diff: {
			magnitude: Math.round((count / total) * 1000) / 1000,
			regions: regions.slice(0, REGION_CAP),
		},
		capped: regions.length > REGION_CAP,
		found: regions.length,
	};
};
