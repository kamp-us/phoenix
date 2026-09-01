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

/**
 * What the board says the lane's issue needs.
 *
 * An epic is an issue the board types `type:epic` **or** one carrying sub-issue links: the label is
 * what a pre-plan epic has, the children are what a planned one has, and #7024's lane was booted in
 * the window where only the first was true. `children` is the link count, so `0` is exactly that
 * pre-plan case.
 *
 * `Child` is the mirror #7024's guard could not reach, because both facts it reads are facts about
 * the issue itself: an epic's child carries no `type:epic` label and no children of its own, so it
 * resolved `Single` and a second lane ledger booted over work the parent's lane already owned
 * (#7381). `parent` is `null` when the board carried the edge and no number that parses.
 */
export type Expectation =
	| {readonly _tag: "Epic"; readonly children: number}
	| {readonly _tag: "Child"; readonly parent: number | null}
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
 *
 * `Child` judges as `Single` does, and deliberately: a child's lane is refused at boot, so one
 * already on disk is a ledger to reconcile rather than a machine to swap, and calling it mismatched
 * here would send `lane migrate` at a fix it does not have (#7381).
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
				reason:
					expectation.children === 0
						? `#${issue} is typed \`type:epic\` and carries no sub-issue links yet, so it has no plan, and this lane runs the booted "${origin.template}" machine, whose one task cannot represent an epic`
						: `#${issue} carries ${expectation.children} sub-issue link(s), and this lane runs the booted "${origin.template}" machine, which has no child regions to drive them`,
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
				reason: `#${issue} is not an epic — no \`type:epic\` label and no sub-issue links — and this lane runs the epic machine emitted for #${origin.epic}`,
			};
};
