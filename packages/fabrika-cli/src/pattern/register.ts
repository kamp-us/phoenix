/**
 * One row inserted into a hand-curated index, and the proof that nothing else moved.
 *
 * **The diff fence is the load-bearing step, and it exists because of who else edits this file.**
 * `.patterns/index.md` carries prose between its tables and is edited by lanes this verb cannot see,
 * so an insertion that reflowed a table, normalised a pipe or rewrote a neighbouring row would
 * destroy work with no diff small enough for a reviewer to notice. {@link linesChangedBeyond} makes
 * that rule mechanical rather than remembered.
 */
import {composeRow, type ParsedIndex, parseIndex, tableSections} from "./index-table.ts";

export type InsertOutcome =
	| {
			readonly _tag: "Inserted";
			readonly text: string;
			readonly row: string;
			readonly section: string;
	  }
	/** A row already links the doc. Registering twice is a no-op, not an error. */
	| {readonly _tag: "Already"; readonly section: string}
	| {readonly _tag: "NoTable"}
	| {readonly _tag: "NoSection"; readonly present: ReadonlyArray<string>}
	| {readonly _tag: "Ambiguous"; readonly count: number}
	| {readonly _tag: "MultiLine"; readonly beyond: number};

export interface InsertRequest {
	readonly slug: string;
	readonly section: string;
	readonly topic: string;
	readonly readWhen: string;
}

/**
 * How many lines the edit changed **beyond** the one row it claims to have added.
 *
 * The check is over the whole file, both directions: a length delta other than `+1`, or any line
 * outside the inserted position that does not survive byte-identically, counts here. `0` is the only
 * value that licenses a write.
 */
export const linesChangedBeyond = (before: string, after: string, insertedAt: number): number => {
	const from = before.split("\n");
	const to = after.split("\n");
	if (to.length !== from.length + 1) return Math.abs(to.length - from.length - 1) + from.length;
	const without = [...to.slice(0, insertedAt), ...to.slice(insertedAt + 1)];
	let beyond = 0;
	for (const [at, line] of from.entries()) if (without[at] !== line) beyond += 1;
	return beyond;
};

/** Where a section's insertion goes: after its last table row, before the next heading. */
const insertionPoint = (index: ParsedIndex, headingLine: number): number | null => {
	const section = index.sections.find((s) => s.headingLine === headingLine);
	return section?.lastRowLine === undefined || section.lastRowLine === null
		? null
		: section.lastRowLine + 1;
};

/**
 * Insert the row, in the contract's order: parse, locate, no-op, insert, prove.
 *
 * The doc's own existence is **not** checked here — it is a filesystem fact the verb proves before
 * calling, so that a row pointing at nothing is refused before any of this runs.
 */
export const insertRow = (text: string, request: InsertRequest): InsertOutcome => {
	const index = parseIndex(text);
	if (!index.hasTable) return {_tag: "NoTable"};

	const matches = index.sections.filter(
		(s) => s.headingLine !== -1 && s.heading === request.section,
	);
	if (matches.length === 0) return {_tag: "NoSection", present: tableSections(index)};
	if (matches.length > 1) return {_tag: "Ambiguous", count: matches.length};

	const existing = index.rows.find((row) => row.member === `${request.slug}.md`);
	if (existing !== undefined) return {_tag: "Already", section: existing.section};

	const heading = matches[0];
	if (heading === undefined) return {_tag: "NoSection", present: tableSections(index)};
	const at = insertionPoint(index, heading.headingLine);
	if (at === null) return {_tag: "NoSection", present: tableSections(index)};

	const row = composeRow(request.slug, request.topic, request.readWhen);
	const lines = text.split("\n");
	const next = [...lines.slice(0, at), row, ...lines.slice(at)].join("\n");

	const beyond = linesChangedBeyond(text, next, at);
	if (beyond > 0) return {_tag: "MultiLine", beyond};

	return {_tag: "Inserted", text: next, row, section: heading.heading};
};

/** Whether a written-back index carries the row under the section, parsed to the same cells. */
export const readBackCarries = (text: string, slug: string, section: string): boolean => {
	const index = parseIndex(text);
	return index.rows.some((row) => row.member === `${slug}.md` && row.section === section);
};
