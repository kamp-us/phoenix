/**
 * Where a row goes, and the assertion that nothing else moved.
 *
 * The one-row invariant is what makes "change only the affected rows, do not re-sort the file" a
 * mechanism rather than a hope: the verb composes the new text, asks {@link linesChangedBeyond}
 * whether the result differs from the original anywhere but the target splice, and aborts the write
 * when it does. It is the `adr supersede` idiom reseated on this group's `15`.
 */
import {compareKeys} from "./findings.ts";
import type {Section} from "./register.ts";

/** The splice a verb intends: remove `replaced` lines at `at`, insert `added` of its own. */
export interface Splice {
	/** 0-based line index. */
	readonly at: number;
	readonly added: number;
	readonly replaced: number;
}

/**
 * How many lines the edit touched **outside** its intended splice. `0` is the invariant holding.
 *
 * The expectation is rebuilt from `after`'s own inserted slice, so the only thing being compared is
 * whether everything around the splice survived byte for byte.
 */
export const linesChangedBeyond = (
	before: ReadonlyArray<string>,
	after: ReadonlyArray<string>,
	splice: Splice,
): number => {
	const expected = [
		...before.slice(0, splice.at),
		...after.slice(splice.at, splice.at + splice.added),
		...before.slice(splice.at + splice.replaced),
	];
	let changed = Math.abs(expected.length - after.length);
	for (let i = 0; i < Math.min(expected.length, after.length); i += 1) {
		if (expected[i] !== after[i]) changed += 1;
	}
	return changed;
};

export interface Placement {
	/** 0-based index the new row's line is inserted at. */
	readonly index: number;
	/** True when the section's existing rows were not already in ascending key order. */
	readonly unsorted: boolean;
}

/**
 * Where a row with `key` belongs in `section`.
 *
 * The rows are placed in ascending key order. Where the section's existing rows are **not** already
 * sorted, the row takes the first position that keeps it ordered against its immediate neighbours —
 * the verb never re-sorts rows it was not asked to write.
 */
export const placeRow = (section: Section, key: string): Placement => {
	const keys = section.rows.map((row) => row.key);
	const unsorted = keys.some(
		(current, index) => index > 0 && compareKeys(keys[index - 1] as string, current) > 0,
	);
	if (section.rows.length === 0) {
		return {index: section.separatorLine ?? 0, unsorted: false};
	}

	for (let i = 0; i <= keys.length; i += 1) {
		const before = i === 0 || compareKeys(keys[i - 1] as string, key) <= 0;
		const after = i === keys.length || compareKeys(key, keys[i] as string) <= 0;
		if (before && after) return {index: lineIndexAt(section, i), unsorted};
	}
	const firstGreater = keys.findIndex((existing) => compareKeys(key, existing) < 0);
	return {
		index: lineIndexAt(section, firstGreater === -1 ? keys.length : firstGreater),
		unsorted,
	};
};

/** The 0-based line index row slot `i` occupies — one past the last row when `i` is the end. */
const lineIndexAt = (section: Section, i: number): number => {
	const at = section.rows[i];
	if (at !== undefined) return at.line - 1;
	const last = section.rows[section.rows.length - 1];
	return last === undefined ? (section.separatorLine ?? 0) : last.line;
};

/** The five lines `--create-section` appends: a blank line, the heading, the two table rows, the row. */
export const newSectionBlock = (section: string, row: string): ReadonlyArray<string> => [
	"",
	`## ${section}`,
	"| Term | Definition | Not |",
	"|---|---|---|",
	row,
];

/**
 * Where a new section's block is appended: past the last line of content, before a trailing empty
 * element that a file ending in a newline splits into.
 */
export const appendIndex = (lines: ReadonlyArray<string>): number =>
	lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
