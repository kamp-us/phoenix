/** The hot-score decay-refresh core, pure — no Effect layer, no DB. */
import {describe, expect, it} from "vitest";
import {computeHotScore} from "./hotScore.ts";
import {decayHotScores} from "./hotScoreDecay.ts";

const HOUR = 3_600_000;

describe("decayHotScores", () => {
	it("recomputes hot_score via the shared computeHotScore formula", () => {
		const now = Date.UTC(2026, 0, 10, 12, 0, 0);
		const createdAtMs = now - 5 * HOUR;
		const updates = decayHotScores([{id: "p1", score: 8, hotScore: 0, createdAtMs}], now);
		expect(updates).toEqual([{id: "p1", hotScore: computeHotScore(8, createdAtMs, now)}]);
	});

	it("decays a frozen hot_score as the post ages, with no activity write", () => {
		const created = Date.UTC(2026, 0, 1, 0, 0, 0);
		const frozen = computeHotScore(5, created, created + 1 * HOUR);
		const later = created + 24 * HOUR;
		const [update] = decayHotScores(
			[{id: "p1", score: 5, hotScore: frozen, createdAtMs: created}],
			later,
		);
		expect(update).toBeDefined();
		expect(update?.hotScore).toBeLessThan(frozen);
		expect(update?.hotScore).toBe(computeHotScore(5, created, later));
	});

	it("emits nothing when the recomputed value is unchanged (no write churn)", () => {
		const now = Date.UTC(2026, 0, 10, 12, 0, 0);
		const createdAtMs = now - 10 * HOUR;
		const current = computeHotScore(3, createdAtMs, now);
		expect(decayHotScores([{id: "p1", score: 3, hotScore: current, createdAtMs}], now)).toEqual([]);
	});

	it("a score-0 post at rest costs no write", () => {
		const now = Date.UTC(2026, 0, 10, 12, 0, 0);
		expect(
			decayHotScores([{id: "fresh", score: 0, hotScore: 0, createdAtMs: now - 2 * HOUR}], now),
		).toEqual([]);
	});

	it("reproduces the bug: after a decay pass, a fresh post outranks a stale squatter", () => {
		const now = Date.UTC(2026, 0, 20, 0, 0, 0);
		const staleCreated = now - 16 * 24 * HOUR;
		// Frozen at ~1h old and never re-decayed — that is the bug being reproduced.
		const staleFrozen = computeHotScore(5, staleCreated, staleCreated + 1 * HOUR);
		const freshCreated = now - 10 * 60_000; // 10 minutes old
		const freshScore = computeHotScore(1, freshCreated, now);

		expect(staleFrozen).toBeGreaterThan(freshScore);

		const updates = decayHotScores(
			[
				{id: "stale", score: 5, hotScore: staleFrozen, createdAtMs: staleCreated},
				{id: "fresh", score: 1, hotScore: freshScore, createdAtMs: freshCreated},
			],
			now,
		);
		const decayedStale = updates.find((u) => u.id === "stale")?.hotScore;
		expect(decayedStale).toBeDefined();
		expect(decayedStale ?? 0).toBeLessThan(freshScore);
	});
});
