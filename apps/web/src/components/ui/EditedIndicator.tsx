import {editedAfter, formatEditedTooltipTR} from "../../lib/datetime";
import {Tooltip} from "./Tooltip";

/**
 * The muted "düzenlendi" edit marker with an edited-at tooltip. Returns null when
 * `updatedAt` is missing or within the grace window, so callers can render it
 * unconditionally without gating on edit state themselves.
 *
 * @component EditedIndicator
 * @whenToUse The edited-marker glyph. Reach for it on any editable entity's meta row
 *   (post, comment, definition) to signal an edit — render it unconditionally and
 *   let it self-suppress when the item is unedited or still within the grace window.
 * @slot none Fixed copy + tooltip; no children slot.
 */
export function EditedIndicator({
	createdAt,
	updatedAt,
}: {
	/** The entity's creation timestamp — the baseline the edit is measured against. */
	createdAt: string | null | undefined;
	/** The entity's last-update timestamp; drives visibility and the tooltip text. */
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
