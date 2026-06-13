import {editedAfter, formatEditedTooltipTR} from "../../lib/datetime";
import {Tooltip} from "./Tooltip";

// Returns null when `updatedAt` is missing or within the grace window, so callers
// can render it unconditionally without gating on edit state themselves.
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
