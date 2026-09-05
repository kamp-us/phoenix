/**
 * Does this element read its own keys? Two surfaces need the same answer and must not drift: the
 * desk skips a press typed into one (`./Desk.tsx`), and the picker declines to pull DOM focus off
 * one (`./PickerView.tsx`).
 */
export const isTextEntry = (target: EventTarget | null | undefined): boolean => {
	if (
		target === null ||
		target === undefined ||
		typeof target !== "object" ||
		!("tagName" in target)
	)
		return false;
	const element = target as {tagName?: unknown; isContentEditable?: unknown};
	const tag = typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
	return tag === "input" || tag === "textarea" || element.isContentEditable === true;
};
