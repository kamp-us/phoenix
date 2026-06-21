/**
 * Unit coverage for `recomputePanoStats` — the pure fold that shapes the
 * `pano_stats` row from the three live COUNTs + the write clock (ADR 0082).
 * No Effect layer, no DB.
 */
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

	it("passes the three counts through unchanged", () => {
		const now = new Date("2024-06-01T12:00:00.000Z");
		const out = recomputePanoStats(
			counts({totalPosts: 12, totalComments: 47, totalAuthors: 9}),
			now,
		);
		expect(out.totalPosts).toBe(12);
		expect(out.totalComments).toBe(47);
		expect(out.totalAuthors).toBe(9);
	});

	it("floors sub-second `now` to whole unix seconds (matches the column)", () => {
		const now = new Date("2024-06-01T12:00:00.999Z");
		expect(recomputePanoStats(counts(), now).updatedAt).toBe(Math.floor(now.getTime() / 1000));
	});

	it("is a pure function of its inputs — same args, same output", () => {
		const now = new Date("2024-06-01T12:00:00.000Z");
		const args = counts({totalPosts: 3, totalComments: 4, totalAuthors: 1});
		expect(recomputePanoStats(args, now)).toEqual(recomputePanoStats(args, now));
	});
});
