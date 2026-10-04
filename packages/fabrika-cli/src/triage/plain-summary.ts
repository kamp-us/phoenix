/**
 * The plain-language summary every `triage enrich` body opens with.
 *
 * The caller sends it as a named section anywhere on stdin; this module lifts it out so the envelope
 * can place it first. Its position is therefore the verb's, never the author's, and a body that
 * drops or empties the section is refused rather than written without one.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */

export const PLAIN_SUMMARY_HEADING = "## In plain words";

/** Stdin split into the summary paragraph and everything else, in the order the author wrote it. */
export interface EnrichText {
	readonly summary: string;
	readonly body: string;
}

export type PlainSummaryRead =
	| {readonly _tag: "Found"; readonly value: EnrichText}
	| {readonly _tag: "Missing"}
	/** The heading is there with no paragraph under it. */
	| {readonly _tag: "Empty"}
	/** More than one heading: which one the author meant is not decidable. */
	| {readonly _tag: "Repeated"; readonly count: number}
	/** The summary was the whole of stdin, so there is no rewrite or pitch to place under it. */
	| {readonly _tag: "Alone"};

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^#{1,6}\s/;

/** Line indices of the summary heading, ignoring any quoted inside a fenced block. */
const headingLines = (lines: ReadonlyArray<string>): ReadonlyArray<number> => {
	const found: number[] = [];
	let fenced = false;
	lines.forEach((line, index) => {
		if (FENCE_RE.test(line)) fenced = !fenced;
		else if (!fenced && line.trim() === PLAIN_SUMMARY_HEADING) found.push(index);
	});
	return found;
};

/**
 * Read the summary section out of `text`.
 *
 * The section is the heading and the one paragraph under it: it ends at the first blank line after
 * the paragraph, or at the next heading. One paragraph is the grammar because the pitch's field
 * lines carry no heading of their own, so "until the next heading" would swallow them.
 */
export const readPlainSummary = (text: string): PlainSummaryRead => {
	const lines = text.split("\n");
	const headings = headingLines(lines);
	const at = headings[0];
	if (at === undefined) return {_tag: "Missing"};
	if (headings.length > 1) return {_tag: "Repeated", count: headings.length};

	let start = at + 1;
	while (start < lines.length && lines[start]?.trim() === "") start++;
	let end = start;
	while (end < lines.length && lines[end]?.trim() !== "" && !HEADING_RE.test(lines[end] ?? "")) {
		end++;
	}
	const summary = lines.slice(start, end).join("\n").trim();
	if (summary === "") return {_tag: "Empty"};

	let after = end;
	while (after < lines.length && lines[after]?.trim() === "") after++;
	const body = [...lines.slice(0, at), ...lines.slice(after)].join("\n").trim();
	if (body === "") return {_tag: "Alone"};
	return {_tag: "Found", value: {summary, body}};
};

/** The section as the envelope writes it, heading included. */
export const renderPlainSummary = (summary: string): string =>
	`${PLAIN_SUMMARY_HEADING}\n\n${summary}`;
