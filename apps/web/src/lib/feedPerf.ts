/**
 * Reload→first-feed-paint instrumentation (#2326, epic #2316 "instant /pano reload").
 * Emits User Timing marks/measures so the epic's floor is readable in a DevTools trace
 * with no analytics dependency.
 *
 * `performance.timeOrigin` IS the reload's navigation start for the top document, so
 * `performance.now()` at paint IS the reload→paint duration — that is why the measure
 * runs from `start: 0`.
 *
 * The `edge` path cannot be seen from a client render (the SPA never fetches the base-feed
 * GET), so it is classified from an injected `cf-cache-status` signal measured at the
 * network layer, not from anything this module observes.
 */
/** Dark-shipped by default: a production build without `VITE_FEED_PERF=on` pays nothing. */
export const FEED_PERF_ENABLED = import.meta.env.DEV || import.meta.env.VITE_FEED_PERF === "on";

export type FeedPaintPath = "snapshot" | "edge" | "cold";

/** The base-feed GET's `cf-cache-status`; `null` when unknown — the SPA cannot see it. */
export type CacheStatus = "HIT" | "MISS" | null;

export interface FeedPathSignals {
	readonly snapshotHydrated: boolean;
	readonly cacheStatus?: CacheStatus;
}

/**
 * Snapshot outranks everything: it paints before any network, so it IS the first paint
 * the user saw. The edge/cold split only applies when no snapshot hydrated.
 */
export function classifyFeedPath({snapshotHydrated, cacheStatus}: FeedPathSignals): FeedPaintPath {
	if (snapshotHydrated) return "snapshot";
	if (cacheStatus === "HIT") return "edge";
	return "cold";
}

// One-way latch: once a snapshot is applied it defined the paint, so this never resets.
let snapshotHydrated = false;

export function noteSnapshotHydrated(): void {
	snapshotHydrated = true;
}

export function wasSnapshotHydrated(): boolean {
	return snapshotHydrated;
}

export const FEED_PAINT_MARK = "pano:feed-paint";

export function feedPaintMeasureName(path: FeedPaintPath): string {
	return `pano:reload->feed-paint:${path}`;
}

export interface PerformanceLike {
	now(): number;
	mark(name: string, options?: {detail?: unknown}): unknown;
	measure(name: string, options: {start?: number; end?: number; detail?: unknown}): unknown;
}

/** Wrapped because a legacy `performance` rejects the User Timing L3 options object —
 *  an instrument must never throw into the render. */
export function recordFeedPaint(
	perf: PerformanceLike,
	path: FeedPaintPath,
	now: number = perf.now(),
): number | null {
	try {
		const detail = {path, reloadToPaintMs: now};
		perf.mark(`${FEED_PAINT_MARK}:${path}`, {detail});
		perf.measure(feedPaintMeasureName(path), {start: 0, end: now, detail});
		return now;
	} catch {
		return null;
	}
}

export function globalPerformance(): PerformanceLike | null {
	const perf = (globalThis as {performance?: Partial<PerformanceLike>}).performance;
	return perf && typeof perf.mark === "function" && typeof perf.measure === "function"
		? (perf as PerformanceLike)
		: null;
}

// Later re-renders (sort swaps, pagination) must not re-mark: the measure is the FIRST
// paint after reload.
let recorded = false;

export function markFeedPaintOnce(
	perf: PerformanceLike | null = globalPerformance(),
	cacheStatus: CacheStatus = null,
): number | null {
	if (!FEED_PERF_ENABLED || recorded || perf == null) return null;
	recorded = true;
	return recordFeedPaint(perf, classifyFeedPath({snapshotHydrated, cacheStatus}));
}

/** Test seam: clear the module-level latches. */
export function resetFeedPaintInstrumentation(): void {
	recorded = false;
	snapshotHydrated = false;
}
