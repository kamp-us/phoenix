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
 * How many lines the rewrite changed **beyond** the status line, or `null` when the answer is
 * "none" — the assertion the contract names as the deterministic test this implementation owes.
 *
 * It compares the text as read against the text as rewritten, line for line, including the line
 * count. A rewrite that dropped a line, duplicated one, or edited a second one is caught here and
 * the caller aborts before writing; an accepted ADR's decision text is immutable, and this is that
 * rule made mechanical instead of remembered.
 */
export const diffBeyondStatusLine = (
	before: ReadonlyArray<string>,
	after: ReadonlyArray<string>,
	statusIndex: number,
): number | null => {
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
 * The assertion compares operands from two independent origins — the original text as read, and
 * the text as re-joined after the edit — so it can genuinely fail: a rewrite that dropped a line,
 * normalised a line ending, or lost the trailing newline shows up as a diff count other than 1 and
 * aborts with `MultiLineDiff` rather than writing.
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
	const diff = diffBeyondStatusLine(lines, rewritten, index);
	if (diff !== null) return {_tag: "MultiLineDiff", changed: diff};
	return {_tag: "Rewritten", text: rewritten.join(newline), statusAfter};
};
