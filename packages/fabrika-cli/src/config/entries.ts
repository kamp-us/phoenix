/** Decoding pieces several key modules share. */

/**
 * An array of non-empty strings, trimmed, or `null` when any entry is not one.
 *
 * `null` rather than a partial list: a malformed entry refuses its key's whole value everywhere on
 * this surface, because a typo'd entry silently dropped is a declaration the operator believes is
 * configured and is not, which surfaces only as a verdict nobody can explain.
 */
export const trimmedStrings = (raw: unknown): ReadonlyArray<string> | null => {
	if (!Array.isArray(raw)) return null;
	const values: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string" || entry.trim() === "") return null;
		values.push(entry.trim());
	}
	return values;
};
