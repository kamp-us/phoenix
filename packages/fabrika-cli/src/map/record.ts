/**
 * `map record`'s pure half: the question id's grammar and the lockstep body edit.
 *
 * <!-- anchor: LOCKSTEP-IS-ONE-WRITE-THEN-ONE --> **The move is one body write, not two.** v1 spread
 * the append, the row removal and the close across three unrelated acts with no transaction, so a
 * failure between them produced exactly the state its own shape doc forbids — *the map is never left
 * in a state where a resolved unknown has no recorded answer*. Folding the two body edits into one
 * PATCH makes that state unrepresentable, which is why {@link applyRecord} returns one string rather
 * than two writes.
 */

import {appendOnly} from "../review/append.ts";
import {
	type DecisionEntry,
	type MapBody,
	parseBody,
	renderDecision,
	renderFrontierRow,
	spliceSection,
} from "./body.ts";

/** The question id inside a `grilling` session. */
export const QUESTION_ID = /^R\d+\.\d+$/;

/** The composed body, or the reason it is not one a later read could hold. */
export type RecordApply =
	| {readonly _tag: "Applied"; readonly body: string}
	| {readonly _tag: "Refused"; readonly reason: string};

/**
 * The body with the answer appended under `## Decisions` and the ticket's row gone from
 * `## Frontier` — one string, so the two cannot separate.
 *
 * Both halves of that string are proven here, before any caller writes bytes. The row removal must
 * still parse, **and** the composed decisions section must be the old entries plus exactly this one
 * that the parser reads back — the second half is the one `map record` shipped without, so a finding
 * whose text broke the entry grammar was caught only by the read-back, after the write had landed
 * (#5550). `map descope` fenced its composed section from the start; this is the same fence.
 */
export const applyRecord = (body: MapBody, ticket: number, entry: DecisionEntry): RecordApply => {
	const withoutRow = spliceSection(
		body,
		"Frontier",
		body.frontier
			.filter((row) => row.ticket !== ticket)
			.map(renderFrontierRow)
			.join("\n"),
	);
	const reparsed = parseBody(withoutRow);
	if (reparsed._tag === "Malformed") {
		return {
			_tag: "Refused",
			reason: `the body stops parsing once #${ticket}'s row is removed (${reparsed.reason})`,
		};
	}

	const priorEntries = reparsed.value.decisions.map(renderDecision);
	const row = renderDecision(entry);
	const composed = [...priorEntries, row].join("\n");
	// The fence compares RENDERED entries, not raw section bytes, and the empty case is its own arm:
	// `appendOnly` counts lines, and an empty section splits to one empty line, so a map's first
	// decision would read as "1 line, expected 2" and refuse the ordinary opening write.
	const violation =
		priorEntries.length === 0
			? composed === row
				? null
				: "the composed section is not exactly this one entry"
			: (() => {
					const fence = appendOnly(priorEntries.join("\n"), composed);
					return fence._tag === "Violates" ? fence.reason : null;
				})();
	if (violation !== null) {
		return {
			_tag: "Refused",
			reason: `the composed decisions section is not the old one plus this entry (${violation})`,
		};
	}

	const next = spliceSection(reparsed.value, "Decisions", composed);
	const read = parseBody(next);
	if (read._tag === "Malformed") {
		return {_tag: "Refused", reason: `the composed body does not parse (${read.reason})`};
	}
	const landed = read.value.decisions;
	const last = landed.at(-1);
	const grew =
		landed.length === priorEntries.length + 1 &&
		landed.slice(0, -1).every((prior, index) => renderDecision(prior) === priorEntries[index]) &&
		last !== undefined &&
		renderDecision(last) === row;
	return grew
		? {_tag: "Applied", body: next}
		: {
				_tag: "Refused",
				reason:
					"the composed body's decisions section does not read back as the old entries plus this one",
			};
};
