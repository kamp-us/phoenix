// Presentational only — the parent owns the mutation and the auth gate. The palette set
// and the accessible names are ADR 0139's; members render as line-icons rather
// than raw OS emoji so they paint in `currentColor` and look the same on every OS.

import {CountToggle} from "@kampus/design";
import type {ReactionEmoji} from "../../../worker/db/reaction-emoji";
import type {ReactionAggregate} from "../../../worker/features/reaction/Reaction";
import {useT} from "../../i18n";
import {ReactionGlyph} from "./ReactionGlyph";
import {reactionSlots} from "./reactionModel";
import "./ReactionBar.css";

export interface ReactionBarProps {
	readonly aggregate: ReactionAggregate | undefined | null;
	readonly onReact: (emoji: ReactionEmoji) => void;
	/** Disambiguates test ids when several bars render on one page — the target id. */
	readonly testIdSuffix: string;
}

export function ReactionBar({aggregate, onReact, testIdSuffix}: ReactionBarProps) {
	const t = useT();
	const slots = reactionSlots(aggregate, t);
	return (
		<div className="kp-reaction-bar" data-testid={`reaction-bar-${testIdSuffix}`}>
			{slots.map((slot) => (
				<CountToggle
					key={slot.emoji}
					pressed={slot.active}
					count={slot.count}
					countTestId={`reaction-count-${slot.emoji}-${testIdSuffix}`}
					icon={<ReactionGlyph emoji={slot.emoji} />}
					aria-label={`${slot.gloss}${slot.count ? ` (${slot.count})` : ""}`}
					data-testid={`reaction-${slot.emoji}-${testIdSuffix}`}
					onClick={() => onReact(slot.emoji)}
				/>
			))}
		</div>
	);
}
