/**
 * The mechanical guards over an authored PR body. *Authoring* stays the skill's; these check shape.
 *
 * Three defects, each with a scar behind it:
 *
 * - **A `## Deviations` section the review gate cannot read**. The check blocks rather
 *   than warns, and "None." counts while silence does not — the verb can force the author to *write*,
 *   never to be honest, so the section's truth stays the skill's problem and its shape is this one's.
 *   The shape itself is not restated here: it is `../wire/deviations.ts`, the same registered format
 *   `review deviations` reads, so a body this verb accepts cannot fail that gate as malformed.
 * - **A stray closing keyword**. One closing line, aimed at this PR's own issue; a second
 *   aimed anywhere else auto-closed an issue the PR did not fix.
 * - **A classification claim**. CODEOWNERS decides control-plane membership at the merge gate
 *   and triage decides type and priority; a body asserting either is a second answer to a gated
 *   question, and a false one shipped.
 *
 * **The classification pattern set is closed on purpose.** Two implementers must ship the same guard,
 * and "refuse any spelling of it" is two guards. Fences, block quotes and inline-code spans are
 * excluded before matching, so a body that *quotes* a classification to discuss it, or names a path or
 * handle that happens to contain one (`control-plane-paths/`, `@acme/control-plane`), is not
 * refused for the quotation. That reach is the same for all three patterns: a `type:` or `p0` inside
 * backticks escapes the guard too.
 */

import {closingKeywords} from "../wire/closing-keyword.ts";
import {read as readDeviations} from "../wire/deviations.ts";

const PART_OF_RE = /\bpart of\s+#(\d+)\b/i;

const CLASSIFICATION_PATTERNS: ReadonlyArray<{readonly name: string; readonly re: RegExp}> = [
	{name: "control-plane", re: /(not[ -])?control[ -]plane/i},
	{name: "type", re: /\btype:[a-z]+\b/i},
	{name: "priority", re: /(^|\s)p[0-3](\s|$|[.,;:!?])/i},
];

/**
 * A CommonMark code span on one line: a backtick run closed by the next run of exactly its length.
 * An unmatched run stays literal, so a stray backtick never swallows the rest of the line.
 */
const INLINE_CODE_RE = /(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;

/**
 * The body with fenced code blocks, block quotes and inline-code spans removed.
 *
 * All three are places an author reproduces text rather than asserts it, and a guard that cannot tell
 * the two apart refuses a body for quoting the thing it is explaining.
 */
export const proseOf = (body: string): string => {
	const lines: string[] = [];
	let fenced = false;
	for (const line of body.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced || /^\s*>/.test(line)) continue;
		lines.push(line.replace(INLINE_CODE_RE, ""));
	}
	return lines.join("\n");
};

/** Why the body's `## Deviations` section is not readable, or `null` when the wire format reads it. */
export const deviationsDefect = (body: string): string | null => {
	const result = readDeviations(body);
	return result._tag === "Found" ? null : result.reason;
};

/**
 * Every issue number a closing keyword in `prose` aims at, in order. A body may carry exactly one,
 * aimed at its own issue.
 */
export const closingTargets = (prose: string): ReadonlyArray<number> => {
	const targets: number[] = [];
	for (const match of prose.matchAll(closingKeywords())) {
		const number = match[1];
		if (number !== undefined) targets.push(Number.parseInt(number, 10));
	}
	return targets;
};

/** The first classification a body asserts, or `null` — the closed pattern set, over prose only. */
export const classificationIn = (prose: string): string | null =>
	CLASSIFICATION_PATTERNS.find(({re}) => re.test(prose))?.name ?? null;

export type BodyDefect =
	/** The section is absent, or present in a shape the review gate reads as malformed. */
	| {readonly _tag: "NoDeviations"; readonly reason: string}
	/** A closing keyword aimed somewhere other than this PR's issue. */
	| {readonly _tag: "StrayClosing"; readonly target: number}
	/** `--partial` was given and the body still auto-closes. */
	| {readonly _tag: "ClosesWhilePartial"; readonly target: number}
	/** The body names no link to its issue at all, in whichever form this run requires. */
	| {readonly _tag: "NoLink"}
	/** More than one closing keyword aimed at this PR's own issue. */
	| {readonly _tag: "DuplicateClosing"};

/**
 * The first shape defect in `body` for a PR serving `issue`, or `null`.
 *
 * The order is deliberate: the Deviations check runs first because it is the one the author most often
 * forgot, and a body missing both should say so about the section rather than about the link.
 */
export const bodyDefect = (body: string, issue: number, partial: boolean): BodyDefect | null => {
	const deviations = deviationsDefect(body);
	if (deviations !== null) return {_tag: "NoDeviations", reason: deviations};

	const prose = proseOf(body);
	const targets = closingTargets(prose);
	const stray = targets.find((target) => target !== issue);
	if (stray !== undefined) return {_tag: "StrayClosing", target: stray};

	const own = targets.filter((target) => target === issue);
	if (partial) {
		if (own.length > 0) return {_tag: "ClosesWhilePartial", target: issue};
		return PART_OF_RE.exec(prose)?.[1] === String(issue) ? null : {_tag: "NoLink"};
	}
	if (own.length === 0) return {_tag: "NoLink"};
	return own.length > 1 ? {_tag: "DuplicateClosing"} : null;
};
