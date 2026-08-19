/**
 * The ledger grammar this gate reads — the epic's sections and the two per-child field lines.
 *
 * Three defect types and the scope digest all rest on it, and v1's equivalents were silently
 * permissive in ways that changed a plan's meaning without saying so. Three refusals answer three
 * scars, and each is a refusal rather than a first-match win because the alternative is a plan whose
 * meaning depends on ordering nobody stated:
 *
 * - **A section that appears twice is undecidable**, not "read the first one".
 * - **A field line that appears twice is undecidable**, likewise.
 * - **Story ids are the list items' own leading integers**, never their positions, and a non-empty
 *   list must run from 1 with no gaps or repeats — v1 read positions, so a mis-numbered list
 *   silently renumbered every story and the coverage defects then pointed at the wrong ones.
 *
 * **Fenced code blocks are scanned by nothing here.** v1 had no fence awareness anywhere, so a
 * documentation example inside a fence set a real child's data.
 *
 * `## Dependencies` is deliberately absent from this module: it is read through the imported
 * `../build/dependencies.ts` parser, and this spec adds no second grammar for it. The **section
 * boundary** is imported from there for the same reason — a section ends at the next heading of
 * equal or shallower depth, or at the first thematic break, and the two readers would silently
 * disagree about where a ledger's last section ends if each spelled that rule itself (#5816).
 */

import {isThematicBreak} from "../build/dependencies.ts";

const FENCE = /^ {0,3}(```|~~~)/;
const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const ORDERED_ITEM = /^[ \t]*(\d+)[.)][ \t]+\S/;

/** One body line the grammar may read: everything inside a fence is dropped before anything looks. */
export interface LedgerLine {
	readonly text: string;
	/** 1-based, so a refusal can point at a line a human can find. */
	readonly line: number;
}

/** The body's lines with every fenced block removed, fences included. */
export const unfencedLines = (body: string): ReadonlyArray<LedgerLine> => {
	const out: LedgerLine[] = [];
	let fence: string | null = null;
	for (const [index, text] of body.split("\n").entries()) {
		const opener = FENCE.exec(text)?.[1];
		if (fence === null) {
			if (opener !== undefined) {
				fence = opener;
				continue;
			}
			out.push({text, line: index + 1});
			continue;
		}
		if (opener?.startsWith(fence) === true) fence = null;
	}
	return out;
};

const normalizeHeading = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

interface Heading {
	readonly level: number;
	readonly key: string;
	readonly index: number;
}

const headingsIn = (lines: ReadonlyArray<LedgerLine>): ReadonlyArray<Heading> => {
	const headings: Heading[] = [];
	for (const [index, {text}] of lines.entries()) {
		const matched = ATX_HEADING.exec(text);
		if (matched?.[1] === undefined || matched[2] === undefined) continue;
		headings.push({level: matched[1].length, key: normalizeHeading(matched[2]), index});
	}
	return headings;
};

/**
 * How many times `heading` opens a section, at any level.
 *
 * Level-indifferent by contract: a ledger is read the same whether its author wrote `##` or `###`,
 * so a duplicate must be caught the same way. The count is what the caller seats the `4` on.
 */
export const sectionCount = (body: string, heading: string): number => {
	const key = normalizeHeading(heading);
	return headingsIn(unfencedLines(body)).filter((h) => h.key === key).length;
};

/**
 * A section's content lines: everything up to the next heading of the same or shallower level, or
 * the first thematic break, whichever comes first.
 */
const sectionBody = (body: string, heading: string): ReadonlyArray<LedgerLine> | null => {
	const lines = unfencedLines(body);
	const headings = headingsIn(lines);
	const key = normalizeHeading(heading);
	const opener = headings.find((h) => h.key === key);
	if (opener === undefined) return null;
	const closer = headings.find((h) => h.index > opener.index && h.level <= opener.level);
	const broken = lines.findIndex(
		(line, index) => index > opener.index && isThematicBreak(line.text),
	);
	const ends = [closer?.index, broken === -1 ? undefined : broken].filter(
		(index): index is number => index !== undefined,
	);
	const end = ends.length === 0 ? lines.length : Math.min(...ends);
	return lines.slice(opener.index + 1, end);
};

export const USER_STORIES_HEADING = "User stories";
export const STORIES_FIELD = "Stories";
export const CONTAINMENT_FIELD = "Containment";

/**
 * The epic's declared story ids.
 *
 * `MisNumbered` is a refusal and the two empty readings are not: an absent section or an empty list
 * reads as zero stories and feeds `MISSING_STORIES_SECTION`, which would otherwise be unreachable.
 * The contiguity rule applies only to a non-empty list.
 */
export type EpicStories =
	| {readonly _tag: "Stories"; readonly ids: ReadonlyArray<number>}
	| {readonly _tag: "MisNumbered"; readonly ids: ReadonlyArray<number>};

export const readEpicStories = (body: string): EpicStories => {
	const section = sectionBody(body, USER_STORIES_HEADING);
	if (section === null) return {_tag: "Stories", ids: []};
	const ids: number[] = [];
	for (const {text} of section) {
		const matched = ORDERED_ITEM.exec(text);
		if (matched?.[1] !== undefined) ids.push(Number.parseInt(matched[1], 10));
	}
	if (ids.length === 0) return {_tag: "Stories", ids: []};
	const contiguous = ids.every((id, i) => id === i + 1);
	return contiguous ? {_tag: "Stories", ids} : {_tag: "MisNumbered", ids};
};

/** The `**<field>:**` lines outside a fence, in order — the caller refuses on a second one. */
export const fieldLines = (body: string, field: string): ReadonlyArray<string> => {
	// Three spellings, because the bolding may close before or after the colon and an unbolded line is
	// still the field: `**Stories:** v`, `**Stories**: v`, `Stories: v`.
	const pattern = new RegExp(
		`^[ \\t]*(?:\\*\\*${field}:\\*\\*|\\*\\*${field}\\*\\*[ \\t]*:|${field}[ \\t]*:)[ \\t]*(.*)$`,
		"i",
	);
	const values: string[] = [];
	for (const {text} of unfencedLines(body)) {
		const matched = pattern.exec(text);
		if (matched?.[1] !== undefined) values.push(matched[1].trim());
	}
	return values;
};

/** The `**Stories:**` value grammar: `none`, or a comma-separated list of bare integers. */
const STORIES_VALUE = /^(none|\d+(\s*,\s*\d+)*)$/i;

/**
 * A child's claimed story ids.
 *
 * `NonConforming` is deliberately **not** a refusal: it reads as absent — which is what
 * `MISSING_STORY` tests — and the offending value is carried so the defect's `detail` can quote it.
 * v1 harvested every bare integer anywhere in the value, so `**Stories:** 1, 3 (see #4021)` silently
 * claimed story 4021.
 */
export type ChildStories =
	| {readonly _tag: "Ids"; readonly ids: ReadonlyArray<number>}
	| {readonly _tag: "Absent"}
	| {readonly _tag: "NonConforming"; readonly value: string};

export const readChildStories = (value: string | undefined): ChildStories => {
	if (value === undefined) return {_tag: "Absent"};
	const text = value.trim();
	if (!STORIES_VALUE.test(text)) return {_tag: "NonConforming", value: text};
	if (text.toLowerCase() === "none") return {_tag: "Ids", ids: []};
	return {
		_tag: "Ids",
		ids: text.split(",").map((part) => Number.parseInt(part.trim(), 10)),
	};
};
