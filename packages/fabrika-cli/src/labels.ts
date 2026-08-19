/**
 * Every `status:` label the pipeline writes, named once.
 *
 * These lived as a private `const` inside each writing verb, and `status bootstrap label-taxonomy`
 * held a fourth copy of two of them and none of the other three — so a bootstrapped repo got five of
 * the sixteen labels the verbs require and could not triage, park, flip a plan or mark a dark ship
 * (#5772). One name in one place is what makes the bootstrap's set derivable rather than restated.
 *
 * The closed *facet* vocabularies — `TYPES`, `PRIORITIES`, `AUDIENCES`, `STANDING_LANES` — stay in
 * `triage/facets.ts`, because those are decode targets for a flag as well as label stems; this file
 * holds only the names that are labels and nothing else.
 */

import {type StatusNames, statusList} from "./config/board.ts";

export const NEEDS_TRIAGE = "status:needs-triage";
export const TRIAGED = "status:triaged";
export const NEEDS_INFO = "status:needs-info";

/** The status every ledger child is born carrying; `plan flip` is what clears it. */
export const PLANNED = "status:planned";

/** Agents deploy, humans release (ADR 0083) — `ship release` marks a dark ship with this. */
export const AWAITING_RELEASE = "status:awaiting-release";

/**
 * The five by role — the shipped default of `boardVocabulary`'s `statuses`, and the shape a repo
 * renaming one of them writes. A role record rather than a list, because "which status is the
 * triaged one" has to survive the rename.
 */
export const DEFAULT_STATUS_NAMES: StatusNames = {
	needsTriage: NEEDS_TRIAGE,
	triaged: TRIAGED,
	needsInfo: NEEDS_INFO,
	planned: PLANNED,
	awaitingRelease: AWAITING_RELEASE,
};

/**
 * The five in the order the bootstrap reports them. Membership here is the contract
 * `bootstrap-verb.ts` derives its taxonomy from: a status label a verb writes and this list omits is
 * a label the bootstrap will not create.
 */
export const STATUSES: ReadonlyArray<string> = statusList(DEFAULT_STATUS_NAMES);
