/**
 * Every `status:` and `class:` label the pipeline writes, named once.
 *
 * These lived as a private `const` inside each writing verb, and `status bootstrap label-taxonomy`
 * held a fourth copy of two of them and none of the other three — so a bootstrapped repo got five of
 * the sixteen labels the verbs require and could not triage, park, flip a plan or mark a dark ship
 * One name in one place is what makes the bootstrap's set derivable rather than restated.
 *
 * The closed *facet* vocabularies — `TYPES`, `PRIORITIES`, `AUDIENCES`, `STANDING_LANES` — stay in
 * `triage/facets.ts`, because those are decode targets for a flag as well as label stems; this file
 * holds only the names that are labels and nothing else.
 */

import {classLabel, type StatusNames, statusList} from "./config/board.ts";
import {SHIP_CLASS_NAMES} from "./review/classes.ts";

export const NEEDS_TRIAGE = "status:needs-triage";
export const TRIAGED = "status:triaged";
export const NEEDS_INFO = "status:needs-info";

/** The status every ledger child is born carrying; `plan flip` is what clears it. */
export const PLANNED = "status:planned";

/** Agents deploy, humans release — `ship release` marks a dark ship with this. */
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

/**
 * The four `class:` labels, in the order the bootstrap reports them.
 *
 * Membership here is the same bootstrap contract {@link STATUSES} carries, and the names are derived
 * from `SHIP_CLASS_NAMES` rather than typed out: a class is what a diff partitions to, so a fifth
 * member of that set has to widen the taxonomy with no second edit. They are derived here and not
 * from `triage/facets.ts`'s `CLASSES` — the same set under its flag-decoding name — because that
 * module reads this one.
 *
 * A board declares neither the set nor its spelling. That is the one asymmetry against the other
 * facets, and it is why the labels have to be minted from code: `triage apply --class` refuses a
 * label the repo lacks rather than letting the API create it, so before the bootstrap owned this row
 * the documented stamp refused on every value and the pre-diff `ui` routing it feeds was unreachable.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9235#issuecomment-5687195334
 */
export const CLASS_LABELS: ReadonlyArray<string> = SHIP_CLASS_NAMES.map(classLabel);
