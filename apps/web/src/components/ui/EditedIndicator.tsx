import {editedAfter, formatEditedTooltipTR} from "../../lib/datetime";
import {Tooltip} from "./Tooltip";

/**
 * Tiny "düzenlendi" label that renders next to content metadata whenever a
 * piece of content has been edited after a `EDITED_GRACE_MS` window past its
 * creation. Hover reveals the full edit timestamp.
 *
 * Rendered by definition cards, post headers, and comment headers (T17).
 * Hidden entirely when `updatedAt` is missing or within the grace window —
 * the caller doesn't have to gate the render itself.
 */
export function EditedIndicator({
	createdAt,
	updatedAt,
}: {
	createdAt: string | null | undefined;
	updatedAt: string | null | undefined;
}) {
	if (!editedAfter(createdAt, updatedAt)) return null;
	const tooltip = formatEditedTooltipTR(updatedAt);
	return (
		<Tooltip content={tooltip}>
			<span
				className="kp-edited-indicator"
				data-testid="edited-indicator"
				title={tooltip}
				style={{
					font: "var(--t-meta)",
					color: "var(--text-muted)",
					fontStyle: "italic",
				}}
			>
				düzenlendi
			</span>
		</Tooltip>
	);
}
