// The pure fold that shapes the `pano_stats` row from the three live COUNTs plus the
// write clock. No Effect layer, no DB.
import {describe, expect, it} from "vitest";
import {type PanoStatsCounts, recomputePanoStats} from "./Pano.ts";

const counts = (over: Partial<PanoStatsCounts> = {}): PanoStatsCounts => ({
	totalPosts: 0,
	totalComments: 0,
	totalAuthors: 0,
	...over,
});

describe("recomputePanoStats", () => {
	it("empty counts → all zero, updatedAt is `now` floored to unix seconds", () => {
		const now = new Date("2024-06-01T12:00:00.000Z");
		expect(recomputePanoStats(counts(), now)).toEqual({
			totalPosts: 0,
			totalComments: 0,
			totalAuthors: 0,
			updatedAt: Math.floor(now.getTime() / 1000),
		});
	});

	it("floors sub-second `now` to whole unix seconds (matches the column)", () => {
		const now = new Date("2024-06-01T12:00:00.999Z");
		expect(recomputePanoStats(counts(), now).updatedAt).toBe(Math.floor(now.getTime() / 1000));
	});
});
