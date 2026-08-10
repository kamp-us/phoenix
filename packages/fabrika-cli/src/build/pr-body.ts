/**
 * The mechanical guards over an authored PR body. *Authoring* stays the skill's; these check shape.
 *
 * Three defects, each with a scar behind it:
 *
 * - **A missing or empty `## Deviations` section** (#4542). The check blocks rather than warns, and
 *   "None." counts while silence does not — the verb can force the author to *write*, never to be
 *   honest, so the section's truth stays the skill's problem and its presence is this one's.
 * - **A stray closing keyword** (#4471). One closing line, aimed at this PR's own issue; a second
 *   aimed anywhere else auto-closed an issue the PR did not fix.
 * - **A classification claim** (#4153). CODEOWNERS decides control-plane membership at the merge gate
 *   and triage decides type and priority; a body asserting either is a second answer to a gated
 *   question, and a false one shipped.
 *
 * **The classification pattern set is closed on purpose.** Two implementers must ship the same guard,
 * and "refuse any spelling of it" is two guards. Fences and block quotes are excluded before matching,
 * so a body that *quotes* a classification to discuss it is not refused for the quotation.
 */

/** GitHub's own auto-closing keywords. A body may carry exactly one, aimed at its own issue. */
const CLOSING_RE = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
const PART_OF_RE = /\bpart of\s+#(\d+)\b/i;

const CLASSIFICATION_PATTERNS: ReadonlyArray<{readonly name: string; readonly re: RegExp}> = [
	{name: "control-plane", re: /(not[ -])?control[ -]plane/i},
	{name: "type", re: /\btype:[a-z]+\b/i},
	{name: "priority", re: /(^|\s)p[0-3](\s|$|[.,;:!?])/i},
];

/**
 * The body with fenced code blocks and block quotes removed.
 *
 * Both are places an author reproduces text rather than asserts it, and a guard that cannot tell the
 * two apart refuses a body for quoting the thing it is explaining.
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
		lines.push(line);
	}
	return lines.join("\n");
};

/** Whether a `## Deviations` heading is present with at least one non-blank line under it. */
export const hasDeviations = (body: string): boolean => {
	const lines = body.split("\n");
	const start = lines.findIndex((line) => /^##\s+Deviations\s*$/.test(line.trim()));
	if (start === -1) return false;
	for (let i = start + 1; i < lines.length; i++) {
		const text = (lines[i] ?? "").trim();
		if (text === "") continue;
		return !/^#{1,6}\s+/.test(text);
	}
	return false;
};

/** Every issue number a closing keyword in `prose` aims at, in order. */
export const closingTargets = (prose: string): ReadonlyArray<number> => {
	const targets: number[] = [];
	CLOSING_RE.lastIndex = 0;
	for (const match of prose.matchAll(CLOSING_RE)) {
		const number = match[3];
		if (number !== undefined) targets.push(Number.parseInt(number, 10));
	}
	return targets;
};

/** The first classification a body asserts, or `null` — the closed pattern set, over prose only. */
export const classificationIn = (prose: string): string | null =>
	CLASSIFICATION_PATTERNS.find(({re}) => re.test(prose))?.name ?? null;

export type BodyDefect =
	| {readonly _tag: "NoDeviations"}
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
	if (!hasDeviations(body)) return {_tag: "NoDeviations"};

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
