import type * as React from "react";
import "./EmptyState.css";

/**
 * The inline empty-state primitive: a composed, centered block a sparse surface
 * renders in place of a bare void (a "0 yorum" label, a feed with no posts, a
 * profile with no contributions). `NotFoundPage` is its full-page 404 sibling —
 * this one fills a region *within* a page so it reads as intentional, not truncated.
 *
 * Slots, not law: an `icon` glyph slot, a required `title`, an optional
 * `description`, and an `action` CTA slot. Composed from existing spacing/text
 * tokens only — it defines no new design-system primitive.
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
