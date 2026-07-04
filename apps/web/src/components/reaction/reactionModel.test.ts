import {describe, expect, it} from "vitest";
import {REACTION_EMOJI} from "../../../worker/db/reaction-emoji";
import type {ReactionAggregate} from "../../../worker/features/reaction/Reaction";
import {nextReaction, reactionOptimistic, reactionSlots} from "./reactionModel";

/**
 * The load-bearing reaction-bar core the three surfaces ship through
 * ({@link reactionSlots} / {@link nextReaction} / {@link reactionOptimistic}) — the
 * palette-render shape, the cardinality-one tap semantics, and the optimistic
 * aggregate delta. These drive the REAL exported functions the `ReactionBar`
 * component + `useReactionBar` hook route through, so a regression in the palette
 * fill, the retract-vs-change decision, or the count math fails here rather than
 * only in an e2e — the `voteOptimistic` unit-test idiom, extended to a 6-way
 * palette.
 */

describe("reactionSlots — the full curated palette, in order", () => {
	it("renders every REACTION_EMOJI member exactly once, in palette order, at zero for an empty aggregate", () => {
		const slots = reactionSlots({counts: [], myReaction: null});
		expect(slots.map((s) => s.emoji)).toEqual([...REACTION_EMOJI]);
		expect(slots.every((s) => s.count === 0)).toBe(true);
		expect(slots.every((s) => s.active === false)).toBe(true);
	});

	it("reads as empty (whole palette at zero) for an undefined/null aggregate — never renders nothing", () => {
		expect(reactionSlots(undefined).map((s) => s.count)).toEqual(REACTION_EMOJI.map(() => 0));
		expect(reactionSlots(null).map((s) => s.emoji)).toEqual([...REACTION_EMOJI]);
	});

	it("surfaces each per-emoji aggregate count, filling zero for palette members absent from the sparse counts", () => {
		const agg: ReactionAggregate = {
			counts: [
				{emoji: "👍", count: 3},
				{emoji: "🔥", count: 1},
			],
			myReaction: null,
		};
		const byEmoji = new Map(reactionSlots(agg).map((s) => [s.emoji, s.count]));
		expect(byEmoji.get("👍")).toBe(3);
		expect(byEmoji.get("🔥")).toBe(1);
		expect(byEmoji.get("❤️")).toBe(0);
	});

	it("highlights exactly the viewer's current reaction (myReaction), nothing else", () => {
		const agg: ReactionAggregate = {counts: [{emoji: "❤️", count: 2}], myReaction: "❤️"};
		const active = reactionSlots(agg).filter((s) => s.active);
		expect(active).toHaveLength(1);
		expect(active[0]?.emoji).toBe("❤️");
	});
});

describe("nextReaction — cardinality-one tap semantics", () => {
	it("tapping the viewer's CURRENT reaction retracts it (→ null)", () => {
		expect(nextReaction("👍", "👍")).toBeNull();
	});

	it("tapping ANOTHER member changes to it (one tap, no intermediate retract)", () => {
		expect(nextReaction("👍", "🔥")).toBe("🔥");
	});

	it("tapping with no current reaction sets it", () => {
		expect(nextReaction(null, "😂")).toBe("😂");
	});
});

describe("reactionOptimistic — the instant-write aggregate after a tap", () => {
	it("a fresh react increments the tapped emoji and sets myReaction", () => {
		const next = reactionOptimistic({counts: [], myReaction: null}, "👍");
		expect(next.myReaction).toBe("👍");
		expect(next.counts).toEqual([{emoji: "👍", count: 1}]);
	});

	it("a retract (tap current) decrements the emoji, drops it at zero, and clears myReaction", () => {
		const next = reactionOptimistic({counts: [{emoji: "👍", count: 1}], myReaction: "👍"}, "👍");
		expect(next.myReaction).toBeNull();
		expect(next.counts).toEqual([]);
	});

	it("a change moves the viewer's tally off the prior emoji onto the new one", () => {
		const agg: ReactionAggregate = {
			counts: [
				{emoji: "👍", count: 2},
				{emoji: "🔥", count: 1},
			],
			myReaction: "👍",
		};
		const next = reactionOptimistic(agg, "🔥");
		expect(next.myReaction).toBe("🔥");
		const byEmoji = new Map(next.counts.map((c) => [c.emoji, c.count]));
		expect(byEmoji.get("👍")).toBe(1);
		expect(byEmoji.get("🔥")).toBe(2);
	});

	it("keeps other users' tallies intact — only the viewer's own contribution moves", () => {
		// 👍 has 5 (incl. the viewer); a retract drops it to 4 (the other 4 stay).
		const next = reactionOptimistic({counts: [{emoji: "👍", count: 5}], myReaction: "👍"}, "👍");
		expect(next.counts).toEqual([{emoji: "👍", count: 4}]);
	});

	it("floors a stale under-count at zero — a retract never renders a negative tally", () => {
		const next = reactionOptimistic({counts: [], myReaction: "👍"}, "👍");
		expect(next.counts).toEqual([]);
		expect(next.myReaction).toBeNull();
	});

	it("orders the optimistic counts by the palette, matching the server's canonical order", () => {
		// react 🔥 first, then (fresh aggregate) react 👍: the result must list 👍 before 🔥.
		const agg: ReactionAggregate = {
			counts: [
				{emoji: "🔥", count: 1},
				{emoji: "😂", count: 1},
			],
			myReaction: null,
		};
		const next = reactionOptimistic(agg, "👍");
		expect(next.counts.map((c) => c.emoji)).toEqual(["👍", "😂", "🔥"]);
	});
});
