/**
 * fabrika's own section of a project README: the text between its start and end marker lines, with
 * whatever a person wrote before and after it kept byte for byte. Pure, so a second run over an
 * already-merged README answers `Unchanged` by this function, not by a live read.
 *
 * The markers are HTML comments, which GitHub hides when it renders Markdown, so a board's reader
 * sees only fabrika's text, never the markers around it.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10084
 */

/** One board's section: `name` keys its marker pair, so two boards' sections never match each other. */
export interface ReadmeSection {
	readonly name: "table" | "on-call";
	readonly body: string;
}

export const startMarker = (section: ReadmeSection): string =>
	`<!-- fabrika:${section.name}:start -->`;

export const endMarker = (section: ReadmeSection): string => `<!-- fabrika:${section.name}:end -->`;

/** The section alone, between its markers: what an empty README becomes. */
export const markedSection = (section: ReadmeSection): string =>
	`${startMarker(section)}\n${section.body}\n${endMarker(section)}`;

/** Which of the README's shapes a write came from, so the verb can say what it did to a person's text. */
export type ReadmeCase =
	/** The README was empty: the marked section is the whole README. */
	| "Fresh"
	/** The README was exactly the unmarked text fabrika wrote before sections existed: now marked. */
	| "Marked"
	/** The README was a person's own text: kept as is, the marked section appended below it. */
	| "Appended"
	/** The README held the markers: only the text between them was replaced. */
	| "Rewrote";

export type ReadmeMerge =
	| {readonly _tag: "Write"; readonly case: ReadmeCase; readonly readme: string}
	| {readonly _tag: "Unchanged"}
	/** The markers are there but do not form one start-then-end pair; the README is left alone. */
	| {readonly _tag: "Broken"};

const occurrences = (text: string, needle: string): ReadonlyArray<number> => {
	const found: number[] = [];
	for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
		found.push(at);
	}
	return found;
};

/** The README `live` should become for `section` to stand in it, keeping every byte a person wrote. */
export const mergeReadme = (live: string | null, section: ReadmeSection): ReadmeMerge => {
	if (live === null || live.trim() === "") {
		return {_tag: "Write", case: "Fresh", readme: markedSection(section)};
	}
	const start = startMarker(section);
	const end = endMarker(section);
	const starts = occurrences(live, start);
	const ends = occurrences(live, end);

	if (starts.length === 0 && ends.length === 0) {
		if (live === section.body) {
			return {_tag: "Write", case: "Marked", readme: markedSection(section)};
		}
		const gap = live.endsWith("\n") ? "\n" : "\n\n";
		return {_tag: "Write", case: "Appended", readme: `${live}${gap}${markedSection(section)}`};
	}

	const [open] = starts;
	const [close] = ends;
	if (starts.length !== 1 || ends.length !== 1 || open === undefined || close === undefined) {
		return {_tag: "Broken"};
	}
	if (close < open) return {_tag: "Broken"};

	const before = live.slice(0, open);
	const after = live.slice(close + end.length);
	const readme = `${before}${markedSection(section)}${after}`;
	return readme === live ? {_tag: "Unchanged"} : {_tag: "Write", case: "Rewrote", readme};
};
