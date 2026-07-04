/**
 * The load-bearing, hook-free core of the curated-palette reaction bar (#1867,
 * epic #1840) — the reaction twin of `voteOptimistic` / `optimisticEdit`. Kept
 * pure and unit-testable apart from React so the palette-render shape, the
 * cardinality-one tap semantics, and the optimistic-aggregate delta are driven
 * by tests, not only by an e2e.
 *
 * The reaction affordance is NOT an open emoji picker: it renders the fixed,
 * curated `REACTION_EMOJI` palette (👍 ❤️ 😂 🤔 😢 🔥) — every palette member is
 * always shown, in palette order, with its aggregate count, and the viewer's own
 * current reaction highlighted. The server's `reactions` aggregate
 * (`ReactionAggregate`) supplies only the members with a non-zero tally plus the
 * viewer's `myReaction`; this core fills the zero-count members so the bar's
 * shape is stable regardless of what the sparse aggregate carries.
 */
import {REACTION_EMOJI, type ReactionEmoji} from "../../../worker/db/reaction-emoji";
import type {ReactionAggregate} from "../../../worker/features/reaction/Reaction";

/**
 * The optimistic aggregate shape fate's `optimistic` payload accepts — a MUTABLE
 * `counts` array, structurally the write-back view's `reactions` field. The
 * server-supplied {@link ReactionAggregate} types `counts` as a `ReadonlyArray`
 * (read side), but fate's `OptimisticUpdate` wants a mutable array, so the
 * optimistic producer returns this mutable twin rather than the readonly one.
 */
export interface OptimisticReactionAggregate {
	counts: Array<{emoji: ReactionEmoji; count: number}>;
	myReaction: ReactionEmoji | null;
}

/** One palette slot as the bar renders it: the emoji, its aggregate count, and whether it is the viewer's current reaction. */
export interface ReactionSlot {
	readonly emoji: ReactionEmoji;
	readonly count: number;
	readonly active: boolean;
}

/** The empty aggregate the bar falls back to when the view supplies none (a target absent from the batch read). */
export const EMPTY_AGGREGATE: ReactionAggregate = {counts: [], myReaction: null};

/**
 * Project a (possibly sparse) `ReactionAggregate` onto the full ordered palette:
 * every `REACTION_EMOJI` member appears exactly once, in palette order, carrying
 * its aggregate count (0 when absent from `counts`) and `active` iff it is the
 * viewer's `myReaction`. A missing/undefined aggregate reads as empty — the bar
 * still renders the whole palette at zero, so a target with no reactions shows the
 * affordance rather than nothing.
 */
export function reactionSlots(aggregate: ReactionAggregate | undefined | null): ReactionSlot[] {
	const agg = aggregate ?? EMPTY_AGGREGATE;
	const countOf = new Map<string, number>(agg.counts.map((c) => [c.emoji, c.count]));
	return REACTION_EMOJI.map((emoji) => ({
		emoji,
		count: countOf.get(emoji) ?? 0,
		active: agg.myReaction === emoji,
	}));
}

/**
 * The cardinality-one tap semantics as the emoji sent to `react`: tapping the
 * viewer's CURRENT reaction retracts it (`null`); tapping any OTHER palette member
 * sets/changes to it. One tap, one reaction per (viewer, target) — never two.
 * Pure so the retract-vs-change decision is unit-tested apart from the hook.
 */
export function nextReaction(
	current: ReactionEmoji | null,
	tapped: ReactionEmoji,
): ReactionEmoji | null {
	return current === tapped ? null : tapped;
}

/**
 * The optimistic `ReactionAggregate` after a tap, given the current aggregate —
 * the reaction analog of `voteOptimistic`. It moves the viewer's own tally off
 * their prior reaction (if any) and onto the new one (unless the tap retracts),
 * clamps every tally at `0` (a retract never renders a negative count), drops
 * zero-count members (matching the server's sparse, non-zero `counts` shape), and
 * re-orders by the palette. Passed to fate as `optimistic: {reactions}`, so the
 * bar updates instantly and fate reconciles/rolls back on the server response.
 */
export function reactionOptimistic(
	aggregate: ReactionAggregate | undefined | null,
	tapped: ReactionEmoji,
): OptimisticReactionAggregate {
	const agg = aggregate ?? EMPTY_AGGREGATE;
	const prior = agg.myReaction;
	const next = nextReaction(prior, tapped);
	const tally = new Map<string, number>(agg.counts.map((c) => [c.emoji, c.count]));
	// Move the viewer's own contribution: -1 off the prior reaction, +1 onto the
	// new one. A retract (next === null) only decrements; a fresh react only
	// increments; a change does both. The 0-floor guards a stale aggregate that
	// under-counts the prior tally.
	if (prior !== null) tally.set(prior, Math.max(0, (tally.get(prior) ?? 0) - 1));
	if (next !== null) tally.set(next, (tally.get(next) ?? 0) + 1);
	const counts = REACTION_EMOJI.flatMap((emoji) => {
		const count = tally.get(emoji) ?? 0;
		return count > 0 ? [{emoji, count}] : [];
	});
	return {counts, myReaction: next};
}
