import {beforeEach, describe, expect, it} from "vitest";
import {
	classifyFeedPath,
	FEED_PAINT_MARK,
	type FeedPaintPath,
	markFeedPaintOnce,
	noteSnapshotHydrated,
	type PerformanceLike,
	recordFeedPaint,
	resetFeedPaintInstrumentation,
} from "./feedPerf";

function fakePerformance(now = 812): PerformanceLike & {
	marks: Array<{name: string; detail: unknown}>;
	measures: Array<{name: string; start?: number; end?: number; detail: unknown}>;
} {
	const marks: Array<{name: string; detail: unknown}> = [];
	const measures: Array<{name: string; start?: number; end?: number; detail: unknown}> = [];
	return {
		marks,
		measures,
		now: () => now,
		mark: (name, options) => void marks.push({name, detail: options?.detail}),
		measure: (name, options) =>
			void measures.push({name, start: options.start, end: options.end, detail: options.detail}),
	};
}

beforeEach(() => resetFeedPaintInstrumentation());

describe("classifyFeedPath", () => {
	it("classifies a hydrated snapshot as the snapshot path — it is the first paint", () => {
		expect(classifyFeedPath({snapshotHydrated: true})).toBe("snapshot");
	});

	it("snapshot outranks an edge cache HIT — leg A paints before any network", () => {
		expect(classifyFeedPath({snapshotHydrated: true, cacheStatus: "HIT"})).toBe("snapshot");
	});

	it("classifies a no-snapshot base-feed cache HIT as the edge path", () => {
		expect(classifyFeedPath({snapshotHydrated: false, cacheStatus: "HIT"})).toBe("edge");
	});

	it("classifies a MISS or unknown cache status (no snapshot) as the cold path", () => {
		expect(classifyFeedPath({snapshotHydrated: false, cacheStatus: "MISS"})).toBe("cold");
		expect(classifyFeedPath({snapshotHydrated: false, cacheStatus: null})).toBe("cold");
		expect(classifyFeedPath({snapshotHydrated: false})).toBe("cold");
	});
});

describe("recordFeedPaint", () => {
	it("emits a path-suffixed mark and a navigation-start→paint measure with detail", () => {
		const perf = fakePerformance(750);
		const duration = recordFeedPaint(perf, "snapshot");

		expect(duration).toBe(750);
		expect(perf.marks).toEqual([
			{name: "pano:feed-paint:snapshot", detail: {path: "snapshot", reloadToPaintMs: 750}},
		]);
		expect(perf.measures).toEqual([
			{
				name: "pano:reload->feed-paint:snapshot",
				start: 0,
				end: 750,
				detail: {path: "snapshot", reloadToPaintMs: 750},
			},
		]);
	});

	it("names the measure per path so each path is a distinct trace entry", () => {
		const paths: FeedPaintPath[] = ["snapshot", "edge", "cold"];
		const perf = fakePerformance();
		for (const path of paths) recordFeedPaint(perf, path);
		expect(perf.measures.map((measure) => measure.name)).toEqual([
			"pano:reload->feed-paint:snapshot",
			"pano:reload->feed-paint:edge",
			"pano:reload->feed-paint:cold",
		]);
	});

	it("degrades to null (never throws) when performance rejects the call", () => {
		const throwing: PerformanceLike = {
			now: () => 10,
			mark: () => {
				throw new Error("legacy performance");
			},
			measure: () => undefined,
		};
		expect(() => recordFeedPaint(throwing, "cold")).not.toThrow();
		expect(recordFeedPaint(throwing, "cold")).toBeNull();
	});
});

describe("markFeedPaintOnce", () => {
	it("records the first paint once and no-ops on every later call (a re-render)", () => {
		const perf = fakePerformance(500);
		expect(markFeedPaintOnce(perf)).toBe(500);
		expect(markFeedPaintOnce(perf)).toBeNull();
		expect(markFeedPaintOnce(perf)).toBeNull();
		expect(perf.marks).toHaveLength(1);
		expect(perf.measures).toHaveLength(1);
	});

	it("tags the paint with the snapshot path when a snapshot hydrated at boot", () => {
		noteSnapshotHydrated();
		const perf = fakePerformance();
		markFeedPaintOnce(perf);
		expect(perf.marks[0]?.name).toBe(`${FEED_PAINT_MARK}:snapshot`);
	});

	it("tags cold by default (no snapshot, no observed cache status)", () => {
		const perf = fakePerformance();
		markFeedPaintOnce(perf);
		expect(perf.marks[0]?.name).toBe(`${FEED_PAINT_MARK}:cold`);
	});

	it("refines to the edge path when a base-feed cache HIT is observed", () => {
		const perf = fakePerformance();
		markFeedPaintOnce(perf, "HIT");
		expect(perf.marks[0]?.name).toBe(`${FEED_PAINT_MARK}:edge`);
	});

	it("no-ops when no performance is available", () => {
		expect(markFeedPaintOnce(null)).toBeNull();
	});
});
