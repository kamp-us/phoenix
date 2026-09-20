/**
 * The names the proof and the config layer share. Separate from `./reviewing-desk.ts` because that
 * module reads its generation at import: a test that imported a constant from it would evaluate the
 * read before it had written the file the read names.
 */

export const FIXTURE_VAR = "TUVAL_AUTHORING_FIXTURE";
export const REVIEW_NODE = "review";
export const DESK_NODE = "desk";
export const SINK_NODE = "sink";
export const REVIEW_PROGRAM = "pr-review";
/** The reviewer's own registered id — what the example's registration fills its `reviewer` arg with. */
export const REVIEWER_PROGRAM = "reviewer";
export const VERDICT = "ship it";

/** One generation of the fixture: the pull request it names, and whether a restored reviewer speaks. */
export interface DeclaredReview {
	readonly reviewing: number;
	/** The reviewer's `resume` announces its verdict again. Its restored ports are unwired. */
	readonly resumeEmits: boolean;
}
