/**
 * The curated reaction **palette** — the closed, ordered set of emoji a user may
 * react with. The reaction system is the third instance of the polymorphic
 * per-user-presence pattern (after `user_vote` / `post_bookmark`), and unlike a
 * free emoji picker its palette is a *curated fixed set*: one template shared
 * across pano + sözlük, seeded from the palette decision (sibling ADR, #1859).
 *
 * `REACTION_EMOJI` is the one runtime tuple the reaction table's `emoji` value
 * column and every react/display path source from — the `TARGET_KINDS` idiom
 * (`db/target-kind.ts`), so code and UI never drift from the decision. An
 * arbitrary emoji is structurally unrepresentable at the wire boundary:
 * `ReactionEmojiSchema` decodes only a palette member, so a non-palette string
 * fails to decode.
 */
import * as Schema from "effect/Schema";

/** The curated closed palette, ordered — the one runtime tuple the wire schema and D1 value source from. */
export const REACTION_EMOJI = ["👍", "❤️", "😂", "🤔", "😢", "🔥"] as const;

export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

/** The one wire/decode schema for a reaction emoji — a non-palette string fails to decode. */
export const ReactionEmojiSchema = Schema.Literals(REACTION_EMOJI);
