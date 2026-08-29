/**
 * Is this lane's machine the machine its issue's board state calls for?
 *
 * A lane's machine and the issue it drives are decided in two different places — the machine by
 * whichever boot verb ran (`lane open`'s committed template, `lane emit`'s generated document), the
 * issue's shape by the board — and until #7024 nothing compared them. An epic whose lane was booted
 * before it had a plan came up on the single-task coder template, and every later diagnostic read it
 * as healthy: the fold replays fine, `lane migrate --check` grafts it cleanly and answers `current`,
 * and the only symptom is a builder backing off because the machine has no child regions to drive.
 *
 * This module is that comparison and nothing else — pure, no board read, no disk. The two inputs are
 * how the document was produced (read off its `id`) and what the board says the issue is; the reader
 * that fetches the second lives in [`expectation.ts`](expectation.ts).
 */

/** What the board says the lane's issue needs. An epic is an issue carrying sub-issue links. */
export type Expectation =
	| {readonly _tag: "Epic"; readonly children: number}
	| {readonly _tag: "Single"};

/**
 * How a lane's machine document was produced, read off its `id` alone.
 *
 * The same recognition [`migrate.ts`](migrate.ts) makes to leave a generated machine out of its
 * sweep: an emitted document is `epic-<n>` and a booted one carries its committed template's id.
 */
export type MachineOrigin =
	| {readonly _tag: "Generated"; readonly epic: number}
	| {readonly _tag: "Booted"; readonly template: string};

const EMITTED_ID = /^epic-(\d+)$/;

export const originOf = (documentId: string): MachineOrigin => {
	const match = EMITTED_ID.exec(documentId);
	return match === null
		? {_tag: "Booted", template: documentId}
		: {_tag: "Generated", epic: Number(match[1])};
};

export type ShapeVerdict =
	| {readonly _tag: "Matches"}
	| {readonly _tag: "Mismatched"; readonly reason: string};

/**
 * Judge one lane's machine against its issue. Every combination seats, because a mismatch the other
 * way — an emitted epic machine on an issue the board says has no children — strands a driver just as
 * completely, and costs nothing to catch here.
 */
export const judgeShape = (
	issue: number,
	origin: MachineOrigin,
	expectation: Expectation,
): ShapeVerdict => {
	if (expectation._tag === "Epic") {
		if (origin._tag === "Booted") {
			return {
				_tag: "Mismatched",
				reason: `#${issue} carries ${expectation.children} sub-issue link(s), and this lane runs the booted "${origin.template}" machine, which has no child regions to drive them`,
			};
		}
		return origin.epic === issue
			? {_tag: "Matches"}
			: {
					_tag: "Mismatched",
					reason: `this lane drives #${issue} and runs the machine emitted for #${origin.epic}`,
				};
	}
	return origin._tag === "Booted"
		? {_tag: "Matches"}
		: {
				_tag: "Mismatched",
				reason: `#${issue} carries no sub-issue links, and this lane runs the epic machine emitted for #${origin.epic}`,
			};
};
