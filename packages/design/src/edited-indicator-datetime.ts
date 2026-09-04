const dateTimeFmt = new Intl.DateTimeFormat("tr-TR", {
	day: "numeric",
	month: "short",
	year: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});

// Edits within this window of createdAt count as the initial submission, not an
// edit — defends against sub-second server-side updatedAt drift after insert.
export const EDITED_GRACE_MS = 60 * 1000;

export function formatEditedTooltipTR(iso: string | null | undefined): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return dateTimeFmt.format(date);
}

export function editedAfter(
	createdAt: string | null | undefined,
	updatedAt: string | null | undefined,
): boolean {
	if (!createdAt || !updatedAt) return false;
	const created = new Date(createdAt).getTime();
	const updated = new Date(updatedAt).getTime();
	if (Number.isNaN(created) || Number.isNaN(updated)) return false;
	return updated - created > EDITED_GRACE_MS;
}
