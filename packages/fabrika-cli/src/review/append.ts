/**
 * The append-only composition: where the new row goes, and the two guards that prove nothing else
 * moved.
 *
 * The guards are the fence, not a formality. ADR 0079's whole point is that a reviewer-authored
 * criterion **adds** to the contract and never rewrites it — v1's `reviewer-append-ac.sh` was
 * mandated at four call sites and called at none, so the fence existed only as a description. Here
 * the composed body is checked twice before it is sent, and the two checks read it through
 * *different* eyes on purpose: one compares lines against the old bytes, the other re-parses the
 * composed body through the **registered wire format** and asserts the block grew by exactly one row.
 * A composition that inserted the row somewhere the parser does not see it passes the first and reds
 * on the second, which is the whole reason both exist.
 */
import {type AcceptanceCriterion, readSpans} from "../wire/acceptance-criteria.ts";

/** The provenance tag ADR 0079 requires — what makes a routed row auditable after the fact. */
export const provenanceTag = (pr: number, round: number): string =>
	`<!-- ac:review pr:#${pr} round:${round} -->`;

export const criterionRow = (text: string, pr: number, round: number): string =>
	`- [ ] ${text.trim()} ${provenanceTag(pr, round)}`;

export type Composition =
	| {readonly _tag: "Composed"; readonly body: string}
	| {readonly _tag: "NoAnchor"; readonly reason: string};

/**
 * `body` with `row` inserted directly after the block's **last criterion**, or `NoAnchor` when the
 * block does not parse and there is nothing to append under.
 *
 * The anchor is the parser's own span — the last row `acceptance-criteria.ts` read, and its last
 * *physical* line — rather than "the last checkbox in the body". Those differ whenever a later
 * section carries checkboxes of its own, and appending to the wrong one puts the row outside the
 * block every future read parses. Taking the span rather than matching the criterion's text is what
 * makes a wrapped last criterion locatable at all: its text is the joined sentence, which appears on
 * no single line (#5716). Inserting after the span's last line — not its checkbox line — is what
 * keeps the new row a sibling instead of one more continuation of the row above it.
 */
export const insertAfterLastCriterion = (body: string, row: string): Composition => {
	const spans = readSpans(body);
	if (spans._tag !== "Found") {
		return {
			_tag: "NoAnchor",
			reason: `the acceptance-criteria block is ${spans._tag.toLowerCase()}: ${spans.reason}`,
		};
	}
	const [head, ...rest] = spans.value;
	const last = rest[rest.length - 1] ?? head;
	const lines = body.split("\n");
	return {
		_tag: "Composed",
		body: [...lines.slice(0, last.lastLine + 1), row, ...lines.slice(last.lastLine + 1)].join("\n"),
	};
};

/** The line a refusal points at, elided so a long row does not swallow the message. */
const quote = (line: string | undefined): string => {
	const text = (line ?? "").trim();
	return text.length > 80 ? `"${text.slice(0, 77)}…"` : `"${text}"`;
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
	let firstDiverged: number | null = null;
	for (const line of after) {
		if (at < before.length && before[at] === line) {
			at += 1;
			continue;
		}
		inserted += 1;
		if (firstDiverged === null) firstDiverged = at;
		if (inserted > 1) {
			return {
				_tag: "Violates",
				reason: `more than one line differs, from line ${firstDiverged + 1}: ${quote(before[firstDiverged])}`,
			};
		}
	}
	return at === before.length
		? {_tag: "AppendOnly"}
		: {_tag: "Violates", reason: `line ${at + 1} was dropped or mutated: ${quote(before[at])}`};
};

/**
 * Whether the block the parser reads back is the old rows plus exactly this one.
 *
 * This is the half {@link appendOnly} cannot see: a row inserted where the format does not parse it
 * leaves the old bytes perfectly intact, so a line-level guard passes while the criterion the caller
 * wrote enters no contract at all. Shared by the pre-write fence and the post-write read-back, so
 * both assert the same thing.
 */
export const grewByOne = (
	before: ReadonlyArray<AcceptanceCriterion>,
	after: ReadonlyArray<AcceptanceCriterion> | null,
	added: string,
): boolean =>
	after !== null &&
	after.length === before.length + 1 &&
	// Both fields, because a flipped checkbox is a mutation of an existing row even though its text
	// is untouched — and the read-back is the only place that mutation would otherwise be invisible.
	before.every(
		(criterion, index) =>
			after[index]?.text === criterion.text && after[index]?.checked === criterion.checked,
	) &&
	(after[before.length]?.text ?? "").includes(added.trim());
