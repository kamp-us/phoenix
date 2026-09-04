import {editedAfter, formatEditedTooltipTR} from "./edited-indicator-datetime";
import {useDesignT} from "./i18n";
import {Tooltip} from "./Tooltip";

/**
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
	createdAt: string | null | undefined;
	updatedAt: string | null | undefined;
}) {
	const t = useDesignT();
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
				{t("ui.edited")}
			</span>
		</Tooltip>
	);
}
