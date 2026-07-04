/**
 * The presentational curated-palette reaction bar (#1867, epic #1840), reused
 * across the three flag-gated surfaces (pano post/comment, sözlük definition) so
 * the affordance is built once, not copy-pasted three times. It renders the fixed
 * `REACTION_EMOJI` palette (never an open picker): one button per palette member,
 * in palette order, each carrying its aggregate count and highlighted (via
 * `aria-pressed`) when it is the viewer's current reaction. The parent owns the
 * mutation + auth gate ({@link useReactionBar}); this only renders the slots and
 * routes a tap to `onReact`.
 */
import type {ReactionEmoji} from "../../../worker/db/reaction-emoji";
import type {ReactionAggregate} from "../../../worker/features/reaction/Reaction";
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
					aria-label={`${slot.emoji} tepki${slot.count ? ` (${slot.count})` : ""}`}
					data-testid={`reaction-${slot.emoji}-${testIdSuffix}`}
					onClick={() => onReact(slot.emoji)}
				>
					<span className="kp-reaction-bar__emoji">{slot.emoji}</span>
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
