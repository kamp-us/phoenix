/**
 * The presentational curated-palette reaction bar (#1867, epic #1840), reused
 * across the three flag-gated surfaces (pano post/comment, sözlük definition) so
 * the affordance is built once, not copy-pasted three times. It renders the fixed
 * `REACTION_EMOJI` palette (never an open picker): one button per palette member,
 * in palette order, each carrying its aggregate count and highlighted (via
 * `aria-pressed`) when it is the viewer's current reaction. The parent owns the
 * mutation + auth gate ({@link useReactionBar}); this only renders the slots and
 * routes a tap to `onReact`.
 *
 * Each member renders as an on-brand monochrome line-icon ({@link ReactionGlyph}),
 * not its raw OS emoji glyph (#2165): the icon paints in `currentColor` so it
 * inherits the button's token (text, or accent when active) and renders identically
 * across OSes — the palette SET is ADR 0139's, unchanged; only the rendering is
 * controlled. The accessible name is ADR 0139's Turkish gloss (`slot.gloss`).
 */
import type {ReactionEmoji} from "../../../worker/db/reaction-emoji";
import type {ReactionAggregate} from "../../../worker/features/reaction/Reaction";
import {ReactionGlyph} from "./ReactionGlyph";
import {reactionSlots} from "./reactionModel";
import "./ReactionBar.css";

export interface ReactionBarProps {
	/** The target's reaction aggregate (per-emoji counts + the viewer's `myReaction`), from the view. */
	readonly aggregate: ReactionAggregate | undefined | null;
	/** Tap a palette emoji: sets/changes it, or retracts if it's the viewer's current reaction (cardinality-one). */
	readonly onReact: (emoji: ReactionEmoji) => void;
	/** Disambiguates test ids when multiple bars render on one page (the target id). */
	readonly testIdSuffix: string;
}

export function ReactionBar({aggregate, onReact, testIdSuffix}: ReactionBarProps) {
	const slots = reactionSlots(aggregate);
	return (
		<div className="kp-reaction-bar" data-testid={`reaction-bar-${testIdSuffix}`}>
			{slots.map((slot) => (
				<button
					key={slot.emoji}
					type="button"
					className="kp-reaction-bar__btn"
					aria-pressed={slot.active}
					aria-label={`${slot.gloss}${slot.count ? ` (${slot.count})` : ""}`}
					data-testid={`reaction-${slot.emoji}-${testIdSuffix}`}
					onClick={() => onReact(slot.emoji)}
				>
					<ReactionGlyph emoji={slot.emoji} />
					{slot.count > 0 ? (
						<span
							className="kp-reaction-bar__count"
							data-testid={`reaction-count-${slot.emoji}-${testIdSuffix}`}
						>
							{slot.count}
						</span>
					) : null}
				</button>
			))}
		</div>
	);
}
