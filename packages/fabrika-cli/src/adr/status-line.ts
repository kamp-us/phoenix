/**
 * `adr supersede` / `adr amend-in-part`, pure: the older record's frontmatter `status:` line is
 * rewritten and nothing else is.
 *
 * An accepted ADR's decision text is immutable. The relationship is named in the *newer* ADR's
 * `## Context`, which these verbs never touch — so the one-line-diff assertion below is that rule
 * made mechanical instead of remembered, and a diff on any other line aborts the write.
 */
import {isSuperseded, sortIds} from "./records.ts";

export type Relationship = "supersede" | "amend-in-part";

/** A `[NNNN](NNNN-slug.md)` link inside a status line. */
export interface StatusLink {
	readonly id: string;
	readonly file: string;
}

const LINK = /\[(\d{4}[a-z]*)\]\(([^)]+)\)/g;

/** Render one link. */
const renderLink = (link: StatusLink): string => `[${link.id}](${link.file})`;

/** The `[NNNN](file)` links a status value already carries, in the order they appear. */
export const parseLinks = (status: string): ReadonlyArray<StatusLink> => {
	const out: StatusLink[] = [];
	for (const m of status.matchAll(LINK)) {
		if (m[1] !== undefined && m[2] !== undefined) out.push({id: m[1], file: m[2]});
	}
	return out;
};

/** True when the status value is already an `amended-in-part by …` list. */
const isAmendedInPart = (status: string): boolean => /^amended-in-part\s+by\b/i.test(status.trim());

/**
 * The status value to write.
 *
 * `supersede` replaces whatever was there. `amend-in-part` **appends** to an existing
 * `amended-in-part by` list in id order — ADR 0023 carries three such links today, and a verb that
 * overwrote instead of appending would silently drop two live relationships. A link already in the
 * list is a no-op: the value comes back unchanged, and the verb still exits 0.
 */
export const nextStatusValue = (
	relationship: Relationship,
	currentStatus: string,
	added: StatusLink,
): string => {
	if (relationship === "supersede") return `superseded by ${renderLink(added)}`;
	const existing = isAmendedInPart(currentStatus) ? parseLinks(currentStatus) : [];
	const byId = new Map<string, StatusLink>();
	for (const link of existing) byId.set(link.id, link);
	if (!byId.has(added.id)) byId.set(added.id, added);
	const ordered = sortIds([...byId.keys()]).map((id) => byId.get(id));
	return `amended-in-part by ${ordered
		.filter((l): l is StatusLink => l !== undefined)
		.map(renderLink)
		.join(", ")}`;
};

/**
 * Split a text into its lines **with their terminators attached**.
 *
 * Retaining the terminator is what makes {@link diffBeyondStatusLine} able to see a line-ending
 * change; a plain `split(/\r?\n/)` discards exactly the byte that changed. The element count matches
 * `split(/\r?\n/)`'s (separators + 1, trailing remainder included), so a status-line index computed
 * on one indexes the other.
 */
const linesWithEndings = (text: string): ReadonlyArray<string> => {
	const out: string[] = [];
	const separator = /\r\n|\n/g;
	let start = 0;
	let m = separator.exec(text);
	while (m !== null) {
		const end = m.index + m[0].length;
		out.push(text.slice(start, end));
		start = end;
		m = separator.exec(text);
	}
	out.push(text.slice(start));
	return out;
};

/**
 * How many lines the rewrite changed **beyond** the status line, or `null` when the answer is
 * "none" — the assertion the contract names as the deterministic test this implementation owes.
 *
 * It takes the two **texts**, not the split array the rewrite worked on, and compares them line for
 * line **including each line's terminator**. That is what makes it a real check rather than a
 * restatement of the edit: `rewriteStatus` splits on `/\r?\n/` and re-joins with one newline it
 * chose, so on a mixed-ending file every line's terminator is rewritten — invisible to a comparison
 * of post-split arrays, visible here, and aborted with `MultiLineDiff` before anything is written.
 * A dropped, duplicated or second-edited line is caught the same way.
 */
export const diffBeyondStatusLine = (
	beforeText: string,
	afterText: string,
	statusIndex: number,
): number | null => {
	const before = linesWithEndings(beforeText);
	const after = linesWithEndings(afterText);
	if (before.length !== after.length) return Math.abs(before.length - after.length);
	let changed = 0;
	for (const [i, line] of before.entries()) {
		if (i !== statusIndex && line !== after[i]) changed += 1;
	}
	return changed === 0 ? null : changed;
};

export type RewriteOutcome =
	| {readonly _tag: "Rewritten"; readonly text: string; readonly statusAfter: string}
	| {readonly _tag: "NoSingleStatusLine"}
	| {readonly _tag: "AlreadySuperseded"}
	| {readonly _tag: "MultiLineDiff"; readonly changed: number};

/** Index of the single frontmatter `status:` line, or `null` when there is not exactly one. */
const statusLineIndex = (lines: ReadonlyArray<string>): number | null => {
	if (lines[0]?.trim() !== "---") return null;
	let end = -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i]?.trim() === "---") {
			end = i;
			break;
		}
	}
	if (end === -1) return null;
	const hits: number[] = [];
	for (let i = 1; i < end; i += 1) {
		if (/^status:/.test(lines[i] ?? "")) hits.push(i);
	}
	return hits.length === 1 ? (hits[0] ?? null) : null;
};

/**
 * Rewrite the record's status line, asserting before returning that the result differs from the
 * original on that line alone.
 *
 * The assertion runs on the **original text as read** against the **re-joined result**, so it can
 * genuinely fail rather than restate the edit. The reachable case is a mixed-ending file: the split
 * below drops every terminator and the join picks one, so a `\r\n` file with a stray `\n` line (or
 * the reverse) has lines rewritten that this verb has no licence to touch — `MultiLineDiff`, nothing
 * written. A dropped or duplicated line would land the same way.
 */
export const rewriteStatus = (
	relationship: Relationship,
	text: string,
	added: StatusLink,
): RewriteOutcome => {
	const newline = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);
	const index = statusLineIndex(lines);
	if (index === null) return {_tag: "NoSingleStatusLine"};
	const currentStatus = (lines[index] ?? "").replace(/^status:\s?/, "");
	if (isSuperseded(currentStatus)) return {_tag: "AlreadySuperseded"};
	const statusAfter = nextStatusValue(relationship, currentStatus, added);
	const rewritten = [...lines];
	rewritten[index] = `status: ${statusAfter}`;
	const rewrittenText = rewritten.join(newline);
	const diff = diffBeyondStatusLine(text, rewrittenText, index);
	if (diff !== null) return {_tag: "MultiLineDiff", changed: diff};
	return {_tag: "Rewritten", text: rewrittenText, statusAfter};
};
