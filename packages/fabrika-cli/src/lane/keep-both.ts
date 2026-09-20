/**
 * Whether one conflicted file is a **plain keep-both** — both sides added lines where the base had
 * none — and, when it is, the text that keeps both.
 *
 * This is the only content judgment the replay makes, and it is deliberately the narrowest one that
 * covers the collision the epic run actually hits: two children each appending a row to a registry
 * file. Nothing here resolves a semantic conflict; a hunk whose base section carries lines is two
 * sides editing the same text, and that is a judgment a verb may not make.
 *
 * The base section only exists under `merge.conflictStyle=diff3`, so the caller passes
 * `-c merge.conflictStyle=diff3` on the pick that produces these markers. A file written without one
 * reads as not-keep-both here, which is the fail-closed arm: a conflict whose base nobody can see is
 * indistinguishable from one whose base is non-empty.
 */

const MARKER_WIDTH = 7;

/** A conflict marker is exactly seven of its character, then end-of-line or a space before a label. */
const marks = (line: string, char: string): boolean =>
	line.startsWith(char.repeat(MARKER_WIDTH)) &&
	(line.length === MARKER_WIDTH || line[MARKER_WIDTH] === " ");

const isOurs = (line: string): boolean => marks(line, "<");
const isBase = (line: string): boolean => marks(line, "|");
const isTheirs = (line: string): boolean => marks(line, "=");
const isEnd = (line: string): boolean => marks(line, ">");

export type KeepBoth =
	/** Every hunk was a plain keep-both, and this is the text that keeps them. */
	| {readonly _tag: "KeepBoth"; readonly text: string; readonly hunks: number}
	/** Not this verb's to resolve, for the reason named. */
	| {readonly _tag: "NotKeepBoth"; readonly reason: string};

const not = (reason: string): KeepBoth => ({_tag: "NotKeepBoth", reason});

const UNTERMINATED = "a conflict block runs to the end of the file unterminated";

const MARKER_SURVIVED =
	"the kept text still carries a conflict marker — a side holds a line shaped like one, so what closed a section was content rather than the marker";

const isMarker = (line: string): boolean =>
	isOurs(line) || isBase(line) || isTheirs(line) || isEnd(line);

/**
 * Read one conflicted file and answer whether keeping both sides is the whole resolution.
 *
 * A hunk qualifies on two conditions together: its base section is empty — neither side rewrote text
 * that was already there — and both sides added something. The second is not redundant: a hunk where
 * one side is empty is an add against a delete, and concatenating it would resurrect content the
 * other side removed on purpose.
 *
 * The kept order is ours-then-theirs: ours is the assembly tip the child is being replayed onto, so
 * what the branch already carries stays above what the child appends.
 */
export const resolveKeepBoth = (text: string): KeepBoth => {
	const lines = text.split("\n");
	// Indexed reads are widened to `string | undefined`, and every marker predicate answers false on
	// the empty string, so a past-the-end read takes the same arm the bounds check already took.
	const at = (index: number): string => lines[index] ?? "";
	const out: Array<string> = [];
	let hunks = 0;
	let cursor = 0;

	const take = (stop: (line: string) => boolean): Array<string> => {
		const taken: Array<string> = [];
		while (cursor < lines.length && !stop(at(cursor))) {
			taken.push(at(cursor));
			cursor += 1;
		}
		return taken;
	};

	while (cursor < lines.length) {
		if (!isOurs(at(cursor))) {
			out.push(at(cursor));
			cursor += 1;
			continue;
		}
		cursor += 1;

		const ours = take((line) => isBase(line) || isTheirs(line) || isEnd(line));
		if (cursor >= lines.length) return not(UNTERMINATED);
		if (!isBase(at(cursor))) {
			return not(
				"a conflict block carries no `|||||||` base section, so whether both sides only added lines cannot be read",
			);
		}
		cursor += 1;

		const base = take((line) => isTheirs(line) || isEnd(line));
		if (cursor >= lines.length) return not(UNTERMINATED);
		if (!isTheirs(at(cursor))) {
			return not("a conflict block's base section is not closed by `=======`");
		}
		cursor += 1;

		const theirs = take(isEnd);
		if (cursor >= lines.length) return not(UNTERMINATED);
		cursor += 1;

		if (base.length > 0) {
			return not(
				`a hunk rewrites ${base.length} line(s) both sides found in the base — that is two sides editing one text, not an append each`,
			);
		}
		if (ours.length === 0 || theirs.length === 0) {
			return not("a hunk has one empty side — an add against a delete, which keeping both undoes");
		}
		out.push(...ours, ...theirs);
		hunks += 1;
	}

	if (hunks === 0) {
		return not(
			"the file carries no conflict markers — a delete/modify or a binary collision, which no textual resolution reaches",
		);
	}
	// The `ours` and `base` sections are validated by what closes them, and `theirs` cannot be: it
	// ends at the first line matching `isEnd`, so a content line shaped like an end marker closes the
	// hunk early and the real marker falls through the outer loop into `out` as ordinary text. That is
	// a wrong acceptance rather than a wrong refusal — the caller stages and commits a live marker —
	// so the answer is refused unless the text it carries is marker-free.
	if (out.some(isMarker)) return not(MARKER_SURVIVED);
	return {_tag: "KeepBoth", text: out.join("\n"), hunks};
};
