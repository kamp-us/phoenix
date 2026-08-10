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

/**
 * The body with the answer appended under `## Decisions` and the ticket's row gone from
 * `## Frontier` — one string, so the two cannot separate.
 *
 * `null` when the intermediate body no longer parses, which a caller seats as a refusal rather than
 * writing bytes it cannot read back.
 */
export const applyRecord = (
	body: MapBody,
	ticket: number,
	entry: DecisionEntry,
): string | null => {
	const withoutRow = spliceSection(
		body,
		"Frontier",
		body.frontier
			.filter((row) => row.ticket !== ticket)
			.map(renderFrontierRow)
			.join("\n"),
	);
	const reparsed = parseBody(withoutRow);
	if (reparsed._tag === "Malformed") return null;
	return spliceSection(
		reparsed.value,
		"Decisions",
		[...reparsed.value.decisions.map(renderDecision), renderDecision(entry)].join("\n"),
	);
};
