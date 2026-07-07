/**
 * Unit coverage for the periodic hot-score decay-refresh core (#2027). Pure — no
 * Effect layer, no DB. Proves the refresh applies the shared formula, decays a stored
 * `hot_score` over elapsed time WITHOUT an activity write, writes only changed rows,
 * and reproduces + guards the reported bug: a fresher post overtaking a stale one
 * once the stale post's frozen score is re-decayed.
 */
import {describe, expect, it} from "vitest";
import {computeHotScore} from "./hotScore.ts";
import {decayHotScores} from "./hotScoreDecay.ts";

const HOUR = 3_600_000;

describe("decayHotScores", () => {
	it("recomputes hot_score via the shared computeHotScore formula", () => {
		const now = Date.UTC(2026, 0, 10, 12, 0, 0);
		const createdAtMs = now - 5 * HOUR;
		// Stored value is stale (0); the recompute must equal the formula at `now`.
		const updates = decayHotScores([{id: "p1", score: 8, hotScore: 0, createdAtMs}], now);
		expect(updates).toEqual([{id: "p1", hotScore: computeHotScore(8, createdAtMs, now)}]);
	});

	it("decays a frozen hot_score as the post ages, with no activity write", () => {
		const created = Date.UTC(2026, 0, 1, 0, 0, 0);
		// The write-time value: computed when the post was 1h old and then FROZEN.
		const frozen = computeHotScore(5, created, created + 1 * HOUR);
		// A refresh pass 24h later re-decays the same score at the later `now`.
		const later = created + 24 * HOUR;
		const [update] = decayHotScores(
			[{id: "p1", score: 5, hotScore: frozen, createdAtMs: created}],
			later,
		);
		expect(update).toBeDefined();
		// Strictly lower — the age term grew, so the stored rank must have dropped.
		expect(update?.hotScore).toBeLessThan(frozen);
		expect(update?.hotScore).toBe(computeHotScore(5, created, later));
	});

	it("emits nothing when the recomputed value is unchanged (no write churn)", () => {
		const now = Date.UTC(2026, 0, 10, 12, 0, 0);
		const createdAtMs = now - 10 * HOUR;
		const current = computeHotScore(3, createdAtMs, now);
		// Stored value already equals the recompute at `now` → steady state → no update.
		expect(decayHotScores([{id: "p1", score: 3, hotScore: current, createdAtMs}], now)).toEqual([]);
	});

	it("a score-0 post at rest costs no write", () => {
		const now = Date.UTC(2026, 0, 10, 12, 0, 0);
		expect(
			decayHotScores([{id: "fresh", score: 0, hotScore: 0, createdAtMs: now - 2 * HOUR}], now),
		).toEqual([]);
	});

	it("reproduces the bug: after a decay pass, a fresh post outranks a stale squatter", () => {
		// The reported scenario: an old post that earned some votes while young keeps a
		// "young, high" frozen score and squats above a genuinely fresh post. Once the
		// refresh re-decays the stale post's stored score at `now`, the fresh post wins.
		const now = Date.UTC(2026, 0, 20, 0, 0, 0);
		const staleCreated = now - 16 * 24 * HOUR;
		// The squatter's FROZEN score: 5 points computed when it was ~1h old (never re-decayed).
		const staleFrozen = computeHotScore(5, staleCreated, staleCreated + 1 * HOUR);
		const freshCreated = now - 10 * 60_000; // 10 minutes old
		const freshScore = computeHotScore(1, freshCreated, now);

		// Before the pass, the frozen squatter outranks the fresher post (the bug).
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
		// After re-decay the stale post drops below the fresher post → ordering fixed.
		expect(decayedStale ?? 0).toBeLessThan(freshScore);
	});
});
