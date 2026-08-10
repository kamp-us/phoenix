/**
 * The deterministic rendered-vs-golden visual diff (pure core). This is the
 * DIFF half of calibration B (#2945): it produces the *signal* — a structured
 * per-surface deviation (magnitude + the differing regions) — never the verdict.
 * The judgment escalation ("is this deviation acceptable?") is the review child's;
 * here we only measure, deterministically, so the same two images always yield
 * the same result (the AC the review gate anchors on).
 *
 * Flake-canon split (the map, #2945): the capture-time half of the canon —
 * animations disabled, reduced-motion, `document.fonts.ready` awaited, srgb
 * forced, seeded data + frozen clock — is enforced when the bytes are RENDERED
 * (the render harness / capture options, #2963), so it is out of this pure core.
 * The DIFF-time half of the canon lives here: known-dynamic regions are MASKED out
 * of the comparison (`DiffOptions.masks`) so a legitimately-varying region (a
 * relative timestamp, an avatar) never reads as a deviation.
 *
 * Operates on already-decoded rasters (RGBA row-major) so it needs no PNG codec
 * and stays a pure, unit-tested total function; decoding candidate/golden PNG
 * bytes into a `RasterImage` is the caller's/render-child's boundary (#2961).
 */

/** An axis-aligned rectangle in device pixels — a mask input or a diff region output. */
export interface Rect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** A decoded image: `pixels` is RGBA, row-major, length exactly `width * height * 4`. */
export interface RasterImage {
	readonly width: number;
	readonly height: number;
	readonly pixels: Uint8Array;
}

/** A contiguous cluster of differing pixels: its bounding box + how many pixels differ. */
export interface DiffRegion extends Rect {
	readonly diffPixels: number;
}

/**
 * The structured diff result — magnitude + regions, never a bare boolean (the AC).
 * `magnitude` is the fraction of COMPARED (unmasked) pixels that differ, in [0, 1];
 * a dimension mismatch is the whole-surface change `magnitude: 1` with no regions.
 */
export interface DiffResult {
	/** Whether the two images share dimensions; `false` short-circuits to a whole-surface diff. */
	readonly dimensionsMatch: boolean;
	/** Candidate dimensions (the render under test). */
	readonly width: number;
	readonly height: number;
	/** Pixels actually compared: `width*height` minus the masked pixels (0 on a dimension mismatch). */
	readonly comparedPixels: number;
	/** Pixels excluded from the compare by a mask region. */
	readonly maskedPixels: number;
	/** Compared pixels that differ beyond the channel threshold. */
	readonly diffPixels: number;
	/** `diffPixels / comparedPixels`, or 0 when nothing was compared; 1 on a dimension mismatch. */
	readonly magnitude: number;
	/** Bounding boxes of the differing clusters (4-connected), in row-major discovery order. */
	readonly regions: readonly DiffRegion[];
}

export interface DiffOptions {
	/** Known-dynamic regions excluded from the compare (the diff-time flake canon). */
	readonly masks?: readonly Rect[];
	/**
	 * Per-channel absolute-delta tolerance below which two pixels are equal (default
	 * 0 = exact). A small value absorbs sub-perceptual raster noise; the acceptance
	 * threshold itself is the review child's judgment (calibration B), not this core.
	 */
	readonly channelThreshold?: number;
}

const assertRaster = (label: string, image: RasterImage): void => {
	if (image.pixels.length !== image.width * image.height * 4) {
		throw new Error(
			`golden-diff: ${label} raster is malformed — ${image.pixels.length} bytes for ${image.width}x${image.height} (expected ${image.width * image.height * 4} RGBA bytes)`,
		);
	}
};

/** Mark every pixel inside any mask rect (clamped to bounds) as excluded from the compare. */
const buildMask = (width: number, height: number, masks: readonly Rect[]): Uint8Array => {
	const masked = new Uint8Array(width * height);
	for (const rect of masks) {
		const x0 = Math.max(0, Math.floor(rect.x));
		const y0 = Math.max(0, Math.floor(rect.y));
		const x1 = Math.min(width, Math.floor(rect.x + rect.width));
		const y1 = Math.min(height, Math.floor(rect.y + rect.height));
		for (let y = y0; y < y1; y++) {
			for (let x = x0; x < x1; x++) {
				masked[y * width + x] = 1;
			}
		}
	}
	return masked;
};

/**
 * Group the differing pixels into 4-connected components and return each one's
 * bounding box + pixel count, in row-major discovery order. Iterative (an explicit
 * stack, not recursion) so a large connected region never overflows the call stack;
 * the row-major scan makes the region ordering deterministic.
 */
const clusterRegions = (width: number, height: number, diff: Uint8Array): DiffRegion[] => {
	const visited = new Uint8Array(width * height);
	const regions: DiffRegion[] = [];
	const stack: number[] = [];
	for (let start = 0; start < diff.length; start++) {
		if (diff[start] === 0 || visited[start] === 1) continue;
		let minX = width;
		let minY = height;
		let maxX = -1;
		let maxY = -1;
		let count = 0;
		stack.push(start);
		visited[start] = 1;
		while (stack.length > 0) {
			const idx = stack.pop() as number;
			const x = idx % width;
			const y = (idx - x) / width;
			count++;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
			const neighbors = [
				x > 0 ? idx - 1 : -1,
				x < width - 1 ? idx + 1 : -1,
				y > 0 ? idx - width : -1,
				y < height - 1 ? idx + width : -1,
			];
			for (const n of neighbors) {
				if (n >= 0 && diff[n] === 1 && visited[n] === 0) {
					visited[n] = 1;
					stack.push(n);
				}
			}
		}
		regions.push({
			x: minX,
			y: minY,
			width: maxX - minX + 1,
			height: maxY - minY + 1,
			diffPixels: count,
		});
	}
	return regions;
};

/**
 * Compute the deterministic diff of a candidate render against its golden. A
 * dimension mismatch is a whole-surface change (`magnitude: 1`, no regions) — the
 * only sane comparison when the grids don't align. Otherwise every unmasked pixel
 * is compared channel-wise: a max-channel abs-delta over `channelThreshold` marks
 * it differing, and the differing pixels are clustered into bounding-box regions.
 */
export const diffRasters = (
	golden: RasterImage,
	candidate: RasterImage,
	options: DiffOptions = {},
): DiffResult => {
	assertRaster("golden", golden);
	assertRaster("candidate", candidate);

	if (golden.width !== candidate.width || golden.height !== candidate.height) {
		return {
			dimensionsMatch: false,
			width: candidate.width,
			height: candidate.height,
			comparedPixels: 0,
			maskedPixels: 0,
			diffPixels: 0,
			magnitude: 1,
			regions: [],
		};
	}

	const {width, height} = candidate;
	const threshold = options.channelThreshold ?? 0;
	const masked = buildMask(width, height, options.masks ?? []);
	const diff = new Uint8Array(width * height);
	let maskedPixels = 0;
	let diffPixels = 0;

	for (let p = 0; p < width * height; p++) {
		if (masked[p] === 1) {
			maskedPixels++;
			continue;
		}
		const o = p * 4;
		const dr = Math.abs((golden.pixels[o] as number) - (candidate.pixels[o] as number));
		const dg = Math.abs((golden.pixels[o + 1] as number) - (candidate.pixels[o + 1] as number));
		const db = Math.abs((golden.pixels[o + 2] as number) - (candidate.pixels[o + 2] as number));
		const da = Math.abs((golden.pixels[o + 3] as number) - (candidate.pixels[o + 3] as number));
		if (Math.max(dr, dg, db, da) > threshold) {
			diff[p] = 1;
			diffPixels++;
		}
	}

	const comparedPixels = width * height - maskedPixels;
	return {
		dimensionsMatch: true,
		width,
		height,
		comparedPixels,
		maskedPixels,
		diffPixels,
		magnitude: comparedPixels === 0 ? 0 : diffPixels / comparedPixels,
		regions: clusterRegions(width, height, diff),
	};
};
