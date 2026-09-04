// A fixed curated palette, never an open picker — see ADR 0139. The server's aggregate is
// SPARSE (non-zero tallies only), so this core fills the zero-count members to keep the
// bar's shape stable.
import {REACTION_EMOJI, type ReactionEmoji} from "../../../worker/db/reaction-emoji";
import type {ReactionAggregate} from "../../../worker/features/reaction/Reaction";
import type {CatalogKey, Translate} from "../../i18n";

// A mutable twin of `ReactionAggregate` purely because fate's `OptimisticUpdate` rejects
// the readonly `counts` array the read side uses. Don't collapse the two.
export interface OptimisticReactionAggregate {
	counts: Array<{emoji: ReactionEmoji; count: number}>;
	myReaction: ReactionEmoji | null;
}

// The glosses ADR 0139 fixes; they are each button's accessible name, not decoration.
export const REACTION_GLOSS_KEYS: Record<ReactionEmoji, CatalogKey> = {
	"👍": "reaction.gloss.thumbsUp",
	"❤️": "reaction.gloss.heart",
	"😂": "reaction.gloss.laughing",
	"🤔": "reaction.gloss.thinking",
	"😢": "reaction.gloss.crying",
	"🔥": "reaction.gloss.fire",
};

export interface ReactionSlot {
	readonly emoji: ReactionEmoji;
	readonly gloss: string;
	readonly count: number;
	readonly active: boolean;
}

export const EMPTY_AGGREGATE: ReactionAggregate = {counts: [], myReaction: null};

export function reactionSlots(
	aggregate: ReactionAggregate | undefined | null,
	t: Translate,
): ReactionSlot[] {
	const agg = aggregate ?? EMPTY_AGGREGATE;
	const countOf = new Map<string, number>(agg.counts.map((c) => [c.emoji, c.count]));
	return REACTION_EMOJI.map((emoji) => ({
		emoji,
		gloss: t(REACTION_GLOSS_KEYS[emoji]),
		count: countOf.get(emoji) ?? 0,
		active: agg.myReaction === emoji,
	}));
}

// Cardinality-one: one reaction per (viewer, target), so re-tapping the current one
// retracts rather than adding a second.
export function nextReaction(
	current: ReactionEmoji | null,
	tapped: ReactionEmoji,
): ReactionEmoji | null {
	return current === tapped ? null : tapped;
}

export function reactionOptimistic(
	aggregate: ReactionAggregate | undefined | null,
	tapped: ReactionEmoji,
): OptimisticReactionAggregate {
	const agg = aggregate ?? EMPTY_AGGREGATE;
	const prior = agg.myReaction;
	const next = nextReaction(prior, tapped);
	const tally = new Map<string, number>(agg.counts.map((c) => [c.emoji, c.count]));
	// The 0-floor guards a stale aggregate that under-counts the prior tally; without it
	// a retract can render a negative count.
	if (prior !== null) tally.set(prior, Math.max(0, (tally.get(prior) ?? 0) - 1));
	if (next !== null) tally.set(next, (tally.get(next) ?? 0) + 1);
	const counts = REACTION_EMOJI.flatMap((emoji) => {
		const count = tally.get(emoji) ?? 0;
		return count > 0 ? [{emoji, count}] : [];
	});
	return {counts, myReaction: next};
}
