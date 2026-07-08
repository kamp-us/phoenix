/**
 * Reload→first-feed-paint instrumentation (#2326, epic #2316 "instant /pano reload").
 *
 * Emits User Timing marks/measures around the pano feed's first paint so the epic's
 * founding floor ("reload → feed on screen") is measurable in a DevTools/Performance
 * trace with NO analytics dependency. The epic's three legs create three paths:
 *   - `snapshot` — leg A hydrated the last-seen feed from `localStorage` at boot, so it
 *     paints at ~JS-boot time (the residual floor the epic names), before any network.
 *   - `edge`     — leg B's viewer-invariant base feed served from the CF edge cache
 *     (fresh-device anon), no session/D1. The SPA does not fetch that GET, so this path
 *     is classified from an injected `cf-cache-status` signal (network-layer measured on
 *     `GET /fate/pano/feed`), never from a client render.
 *   - `cold`     — today's path: the full worker→D1 read, gated behind the session.
 *
 * The measure spans navigation start → paint. `performance.timeOrigin` IS the reload's
 * navigation start for the top document, so `performance.now()` at paint is the
 * reload→paint duration — the measure runs from `start: 0` (i.e. `timeOrigin`) to it.
 *
 * Cost/containment (AC#3): a one-shot mark+measure is negligible, but per the epic's
 * dark-ship ethos it is gated behind `FEED_PERF_ENABLED` — dev builds, plus an opt-in
 * `VITE_FEED_PERF` measurement/stage build — so a production bundle pays nothing by
 * default. Every call is best-effort: an absent or throwing `performance` (SSR, a
 * legacy engine that rejects the L3 options object) degrades to a no-op, never a
 * user-visible effect.
 */

/** Instrument gate: on in dev, or in a build that opts in via `VITE_FEED_PERF=on`
 *  (a measurement/stage bundle). Off in a default production build ⇒ zero cost. A
 *  build-time env flag, like `VITE_FEED_SNAPSHOT` — see `vite-env.d.ts`. */
export const FEED_PERF_ENABLED = import.meta.env.DEV || import.meta.env.VITE_FEED_PERF === "on";

/** Which path produced the first feed paint. */
export type FeedPaintPath = "snapshot" | "edge" | "cold";

/** The CF edge-cache status of the base-feed GET (leg B), read from its `cf-cache-status`
 *  response header; `null` when unknown/not applicable (the SPA does not fetch that GET). */
export type CacheStatus = "HIT" | "MISS" | null;

export interface FeedPathSignals {
	readonly snapshotHydrated: boolean;
	readonly cacheStatus?: CacheStatus;
}

/**
 * Classify which path produced the first paint. Snapshot wins whenever a snapshot
 * hydrated — that IS the first paint the user sees (leg A paints before any network),
 * so the edge/cold distinction only applies to the no-snapshot case. Among those, an
 * edge cache HIT on the base feed outranks the cold worker→D1 path; everything else is
 * cold. This is the rule the epic's flag-flip evidence rests on.
 */
export function classifyFeedPath({snapshotHydrated, cacheStatus}: FeedPathSignals): FeedPaintPath {
	if (snapshotHydrated) return "snapshot";
	if (cacheStatus === "HIT") return "edge";
	return "cold";
}

/** Latched at boot when a feed snapshot hydrated (leg A) — read at first paint to
 *  classify the path. A one-way latch: once a snapshot is applied it defined the paint. */
let snapshotHydrated = false;

/** Record that a feed snapshot hydrated at boot (leg A). Called from the public/authed
 *  client wiring only when `hydrateFromSnapshot` actually applied a snapshot. */
export function noteSnapshotHydrated(): void {
	snapshotHydrated = true;
}

export function wasSnapshotHydrated(): boolean {
	return snapshotHydrated;
}

/** The one paint-mark name (path-suffixed so each path is a distinct trace entry). */
export const FEED_PAINT_MARK = "pano:feed-paint";

/** The navigation-start→paint measure name for a path (rendered in the DevTools
 *  Performance/User Timing lane). */
export function feedPaintMeasureName(path: FeedPaintPath): string {
	return `pano:reload->feed-paint:${path}`;
}

/** The `performance` slice this module drives, injected so the recorder is testable
 *  without a real `performance` (and so a partial jsdom impl can be faked precisely). */
export interface PerformanceLike {
	now(): number;
	mark(name: string, options?: {detail?: unknown}): unknown;
	measure(name: string, options: {start?: number; end?: number; detail?: unknown}): unknown;
}

/**
 * Emit the paint mark + a navigation-start→paint measure for `path`, returning the
 * reload→paint duration in ms (or `null` when `performance` threw / was unusable).
 * Best-effort: wrapped so a legacy `performance` that rejects the User Timing L3 options
 * object never throws into the render.
 */
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

/** `globalThis.performance` when it exposes the User Timing surface, else `null`
 *  (SSR / a test env without it) so callers degrade cleanly. */
export function globalPerformance(): PerformanceLike | null {
	const perf = (globalThis as {performance?: Partial<PerformanceLike>}).performance;
	return perf && typeof perf.mark === "function" && typeof perf.measure === "function"
		? (perf as PerformanceLike)
		: null;
}

/** Latched once the first paint is recorded — later feed re-renders (sort swaps,
 *  pagination) must not re-mark; the epic measures the FIRST paint after reload. */
let recorded = false;

/**
 * Record the first feed paint exactly once for the tab's lifetime. No-op when the
 * instrument is disabled, already recorded, or `performance` is unavailable. `cacheStatus`
 * refines the no-snapshot case to edge vs cold when a caller can observe the base-feed
 * `cf-cache-status`; it defaults to `null` (the SPA render can't see it → the network-layer
 * methodology distinguishes edge from cold on the GET itself).
 */
export function markFeedPaintOnce(
	perf: PerformanceLike | null = globalPerformance(),
	cacheStatus: CacheStatus = null,
): number | null {
	if (!FEED_PERF_ENABLED || recorded || perf == null) return null;
	recorded = true;
	return recordFeedPaint(perf, classifyFeedPath({snapshotHydrated, cacheStatus}));
}

/** Test seam: clear the module-level latches so each test starts from a clean instrument. */
export function resetFeedPaintInstrumentation(): void {
	recorded = false;
	snapshotHydrated = false;
}
