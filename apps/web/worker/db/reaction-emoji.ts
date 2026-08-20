/**
 * The curated reaction palette — a closed fixed set, not a free emoji picker. This
 * tuple is the one source the reaction table's `emoji` column and every react/display
 * path read from (the `TARGET_KINDS` idiom), so an arbitrary emoji is structurally
 * unrepresentable at the wire boundary.
 */
import * as Schema from "effect/Schema";

export const REACTION_EMOJI = ["👍", "❤️", "😂", "🤔", "😢", "🔥"] as const;

export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

export const ReactionEmojiSchema = Schema.Literals(REACTION_EMOJI);
