/**
 * The one rule over an epic run's assembly PR body: it must close the epic.
 *
 * An epic run is one branch and one PR, so that PR is the whole run's landing. A tail body that
 * reaches the epic through `Part of #<epic>` — or through nothing at all, having closed only the
 * children — merges without closing it, and the lane folds to `shipped` then `complete` over an
 * epic the board still calls open.
 *
 * **The reader is `issueRefsOf`, the same one `./closure.ts` judges the merged PR with.** That is
 * the whole design: this guard refuses exactly the bodies that reader would later call `partial` or
 * leave unreadable, so the authoring seam and the recording seam cannot disagree about one body.
 * Writing a second link reader here would be two rules wearing one name.
 *
 * A tail body's *other* closing keywords are not this module's business. It carries one per landed
 * child by contract, and refusing those would refuse the shape `operate` asks for.
 */

import {issueRefsOf} from "../review/classes.ts";

export type TailBodyRead =
	/** A closing keyword aims at the epic — the body is the run's landing it claims to be. */
	| {readonly _tag: "Closes"}
	/** It does not, and `read` says in the reader's own words what the body reaches the epic by. */
	| {readonly _tag: "Unclosing"; readonly read: string};

/**
 * Whether `body` closes `epic`, and what it says instead when it does not.
 *
 * Membership rather than the first reference: a tail body carries one closing keyword per landed
 * child at an arbitrary position among them, so "does this close the epic" is a set question and a
 * scalar reader would answer it off whichever child happens to lead.
 */
export const tailBodyRead = (body: string, epic: number): TailBodyRead => {
	const refs = issueRefsOf(body);
	if (refs.kind === "fixes" && refs.numbers.includes(epic)) return {_tag: "Closes"};
	if (refs.kind === "none") {
		return {_tag: "Unclosing", read: "it links no issue at all"};
	}
	const links = refs.numbers.map((number) => `#${number}`).join(", ");
	return {
		_tag: "Unclosing",
		read:
			refs.kind === "part-of"
				? `it reaches ${links} through "Part of", which closes nothing`
				: `its closing keywords aim at ${links} instead`,
	};
};
