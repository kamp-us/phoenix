import {describe, expect, it} from "vitest";
import {computeHotScore, hotMultiplier} from "./hotScore.ts";

const HOUR_MS = 3_600_000;

describe("hotScore", () => {
	describe("computeHotScore", () => {
		it("is the floored HN decay floor(score * 1000 / (hoursOld + 2)^1.8)", () => {
			const now = 1_000 * HOUR_MS;
			for (const score of [0, 1, 5, 42, 1000]) {
				for (const ageHours of [0, 1, 3, 10, 24, 168]) {
					const createdAt = now - ageHours * HOUR_MS;
					const expected = Math.floor((score * 1000) / (ageHours + 2) ** 1.8);
					expect(computeHotScore(score, createdAt, now)).toBe(expected);
				}
			}
		});

		it("decays monotonically with age for a fixed score", () => {
			const now = 1_000 * HOUR_MS;
			const score = 100;
			let prev = Number.POSITIVE_INFINITY;
			for (const ageHours of [0, 1, 2, 4, 8, 16, 32]) {
				const current = computeHotScore(score, now - ageHours * HOUR_MS, now);
				expect(current).toBeLessThanOrEqual(prev);
				prev = current;
			}
		});

		it("floors a future createdAt to age 0 (no clock-skew boost)", () => {
			const now = 1_000 * HOUR_MS;
			const future = now + 5 * HOUR_MS;
			expect(computeHotScore(50, future, now)).toBe(computeHotScore(50, now, now));
		});

		it("is zero for a zero score regardless of age", () => {
			const now = 1_000 * HOUR_MS;
			expect(computeHotScore(0, now, now)).toBe(0);
			expect(computeHotScore(0, now - 100 * HOUR_MS, now)).toBe(0);
		});
	});

	describe("hotMultiplier", () => {
		it("is the per-vote weight 1000 / (hoursOld + 2)^1.8", () => {
			const now = 1_000 * HOUR_MS;
			for (const ageHours of [0, 1, 3, 10, 24]) {
				const createdAt = now - ageHours * HOUR_MS;
				expect(hotMultiplier(createdAt, now)).toBeCloseTo(1000 / (ageHours + 2) ** 1.8, 10);
			}
		});

		it("at age 0 is 1000 / 2^1.8", () => {
			const now = 1_000 * HOUR_MS;
			expect(hotMultiplier(now, now)).toBeCloseTo(1000 / 2 ** 1.8, 10);
		});

		it("composes with score to give computeHotScore", () => {
			const now = 1_000 * HOUR_MS;
			const createdAt = now - 7 * HOUR_MS;
			for (const score of [0, 3, 50, 999]) {
				expect(computeHotScore(score, createdAt, now)).toBe(
					Math.floor(score * hotMultiplier(createdAt, now)),
				);
			}
		});
	});
});
