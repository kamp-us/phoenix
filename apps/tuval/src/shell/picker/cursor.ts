/**
 * The cursor arithmetic every picker list shares: the program list and the "Open project…" steps
 * (#9697) move one highlight the same way, so a key cannot mean one thing in one list and another in
 * the next.
 */

/** `cursor` held inside `length` rows. Movement clamps instead of wrapping (the APG listbox default). */
export const clamp = (cursor: number, length: number): number => {
	if (length === 0) return 0;
	if (!Number.isInteger(cursor) || cursor < 0) return 0;
	return cursor > length - 1 ? length - 1 : cursor;
};

/**
 * Where Page Down and Page Up land (#9694): the first row of the next group, or of the group the
 * cursor is in when it is past that group's first row, else of the previous group. `keys[i]` is
 * row `i`'s group. It clamps like every other move.
 */
export const groupJump = (
	keys: ReadonlyArray<string>,
	at: number,
	direction: "next" | "previous",
): number => {
	const starts = keys.flatMap((key, index) =>
		index === 0 || key !== keys[index - 1] ? [index] : [],
	);
	if (direction === "next") return starts.find((start) => start > at) ?? at;
	return [...starts].reverse().find((start) => start < at) ?? at;
};
