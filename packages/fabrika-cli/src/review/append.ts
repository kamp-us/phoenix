/**
 * The append-only composition: where the new row goes, and the diff guard that proves nothing else
 * moved.
 *
 * The guard is the fence, not a formality. ADR 0079's whole point is that a reviewer-authored
 * criterion **adds** to the contract and never rewrites it — v1's `reviewer-append-ac.sh` was
 * mandated at four call sites and called at none, so the fence existed only as a description. Here
 * the composed body is compared line-for-line against the old one before it is sent, and any drop or
 * mutation refuses.
 */

const CHECKBOX = /^[ \t]*[-*][ \t]+\[[ xX]\]/;

/** The provenance tag ADR 0079 requires — what makes a routed row auditable after the fact. */
export const provenanceTag = (pr: number, round: number): string =>
	`<!-- ac:review pr:#${pr} round:${round} -->`;

export const criterionRow = (text: string, pr: number, round: number): string =>
	`- [ ] ${text.trim()} ${provenanceTag(pr, round)}`;

/**
 * `body` with `row` inserted after the last checkbox line, or `null` when there is none to follow.
 *
 * "After the last checkbox" rather than "at the end of the section" keeps the row inside the block a
 * later read parses, even when the section trails prose.
 */
export const insertAfterLastCheckbox = (body: string, row: string): string | null => {
	const lines = body.split("\n");
	let last = -1;
	for (const [index, line] of lines.entries()) {
		if (CHECKBOX.test(line)) last = index;
	}
	if (last < 0) return null;
	return [...lines.slice(0, last + 1), row, ...lines.slice(last + 1)].join("\n");
};

export type AppendGuard =
	| {readonly _tag: "AppendOnly"}
	| {readonly _tag: "Violates"; readonly reason: string};

/**
 * Whether `next` is `previous` plus exactly one line and nothing else.
 *
 * Both halves are asserted: exactly one added line, and every original line still present in its
 * original order. Checking only the length would wave through a body that swapped one line for
 * another and added a third.
 */
export const appendOnly = (previous: string, next: string): AppendGuard => {
	const before = previous.split("\n");
	const after = next.split("\n");
	if (after.length !== before.length + 1) {
		return {
			_tag: "Violates",
			reason: `the composed body has ${after.length} lines, expected ${before.length + 1}`,
		};
	}
	let inserted = 0;
	let at = 0;
	for (const line of after) {
		if (at < before.length && before[at] === line) {
			at += 1;
			continue;
		}
		inserted += 1;
		if (inserted > 1) return {_tag: "Violates", reason: "more than one line differs"};
	}
	return at === before.length
		? {_tag: "AppendOnly"}
		: {_tag: "Violates", reason: "an original line was dropped or mutated"};
};
