import type * as React from "react";
import "./EmptyState.css";

/**
 * Composed from existing spacing/text tokens only — it defines no new primitive.
 *
 * @component EmptyState
 * @whenToUse The inline empty-state block. Reach for it to fill a sparse region
 *   within a page (an empty feed, a zero-count list, a contribution-less profile)
 *   so the void reads as intentional. For a full-page miss use `NotFoundPage`, its
 *   404 sibling, instead.
 * @slot icon Optional decorative glyph above the title (aria-hidden).
 * @slot title The required headline for the empty state.
 * @slot description Optional supporting line under the title.
 * @slot action Optional CTA (e.g. a Button) below the copy.
 */
export function EmptyState({
	icon,
	title,
	description,
	action,
	className = "",
}: {
	icon?: React.ReactNode;
	title: React.ReactNode;
	description?: React.ReactNode;
	action?: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={`kp-empty-state ${className}`.trim()} data-testid="empty-state">
			{icon ? (
				<div className="kp-empty-state__icon" aria-hidden="true">
					{icon}
				</div>
			) : null}
			<p className="kp-empty-state__title">{title}</p>
			{description ? <p className="kp-empty-state__description">{description}</p> : null}
			{action ? <div className="kp-empty-state__action">{action}</div> : null}
		</div>
	);
}
