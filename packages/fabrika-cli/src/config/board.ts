/**
 * The board vocabulary — the five label sets triage reconciles over — and how each facet's delete
 * authority is derived from them.
 *
 * Pure: it imports the containment rule and nothing else, because `../triage/facets.ts` imports
 * *this* to build the shipped default. The load-side composition (which needs the key modules) is
 * `./resolve-board.ts`.
 *
 * **Statuses are roles, not a list.** A repo renaming `status:triaged` has to say *which* status it
 * renamed — a five-entry array cannot, and positional meaning is the kind of invalid state this
 * package refuses to represent. Types, priorities, audiences and lanes are open lists: nothing in
 * the reconcile needs to know which member is which.
 *
 * **The pipeline still recognises two stems by name**: the type `epic` (its deliverable is a ledger,
 * not a PR) and the audience `agent` (the acceptance-criteria promise is made to one). A repo may
 * add members and rename the others; renaming those two away drops the behaviour they carry.
 */

import {containmentRefusal, type FacetVocabulary, type Ownership} from "./containment.ts";

/** Each `status:` label by the role it plays, so a rename cannot lose which status it renamed. */
export interface StatusNames {
	readonly needsTriage: string;
	readonly triaged: string;
	readonly needsInfo: string;
	readonly planned: string;
	readonly awaitingRelease: string;
}

export interface BoardVocabulary {
	readonly statuses: StatusNames;
	/** Bare stems: the label is `type:<stem>`. */
	readonly types: ReadonlyArray<string>;
	/** Whole label names — a priority has no prefix. */
	readonly priorities: ReadonlyArray<string>;
	/** Bare stems: the label is `ready-for:<stem>`. */
	readonly audiences: ReadonlyArray<string>;
	/** Whole label names, and an open set: a repo's lanes are its own. */
	readonly standingLanes: ReadonlyArray<string>;
}

/** The label form of one type. Every `type:*` label the package writes or matches comes from here. */
export const typeLabel = (type: string): string => `type:${type}`;

/** The label form of one audience. */
export const audienceLabel = (audience: string): string => `ready-for:${audience}`;

/**
 * The five statuses in the order the bootstrap reports them. A status a verb writes and this list
 * omits is a label the bootstrap will not create.
 */
export const statusList = (statuses: StatusNames): ReadonlyArray<string> => [
	statuses.needsTriage,
	statuses.triaged,
	statuses.needsInfo,
	statuses.planned,
	statuses.awaitingRelease,
];

/**
 * The three statuses triage itself moves between. `planned` and `awaitingRelease` are written by
 * `plan`/`ledger` and `ship`, so the status facet preserves them rather than reconciling them away.
 */
export const triageStatuses = (statuses: StatusNames): ReadonlyArray<string> => [
	statuses.needsTriage,
	statuses.triaged,
	statuses.needsInfo,
];

export const FACET_NAMES = ["type", "priority", "status", "audience", "lane"] as const;
export type FacetName = (typeof FACET_NAMES)[number];

/** Every label an input can make each facet keep, off one board vocabulary. */
export const facetValues = (
	board: BoardVocabulary,
): Readonly<Record<FacetName, ReadonlyArray<string>>> => ({
	type: board.types.map(typeLabel),
	priority: [...board.priorities],
	status: triageStatuses(board.statuses),
	audience: board.audiences.map(audienceLabel),
	lane: [...board.standingLanes],
});

/** A board vocabulary and the facet table that reconciles it — what a call site is handed. */
export interface ResolvedBoard {
	readonly board: BoardVocabulary;
	readonly facets: ReadonlyArray<FacetVocabulary>;
}

export type Composed =
	| {readonly _tag: "Vocabulary"; readonly facets: ReadonlyArray<FacetVocabulary>}
	| {readonly _tag: "Refused"; readonly reason: string};

const ownershipFor = (
	name: FacetName,
	values: ReadonlyArray<string>,
	key: string,
	shipped: ReadonlyArray<FacetVocabulary>,
): Ownership => {
	const inherited = shipped.find((facet) => facet.name === name)?.owns;
	if (inherited === undefined) return {_tag: "Set", labels: values};
	// Inherit the shipped ownership only where it still contains the declared values in both
	// directions. `^p\d+$` is deliberately wider than `p0..p2` so a retired priority is still
	// cleaned up, and that width is worth keeping for a repo that merely drops `p2` — but a repo
	// whose priorities are `sev1, sev2` is not owned by it at all, and inheriting there would write
	// a label the facet can never supersede (#4285).
	return containmentRefusal(key, [{name, owns: inherited, values}]) === null
		? inherited
		: {_tag: "Set", labels: values};
};

/**
 * The facet table a resolved board reconciles through.
 *
 * Ownership comes from `declared` where a repo stated it, else from the shipped table, else from the
 * values themselves. Values always come from the board, so the two keys cannot drift into the state
 * where `boardVocabulary` produces a label `triageFacets` has no authority to remove.
 *
 * A declared facet whose name is not one of the five is refused rather than ignored: an inert facet
 * declaration reads as configured and is not.
 */
export const composeFacets = (
	key: string,
	board: BoardVocabulary,
	shipped: ReadonlyArray<FacetVocabulary>,
	declared: ReadonlyArray<FacetVocabulary> | null,
): Composed => {
	const known: ReadonlyArray<string> = FACET_NAMES;
	const stray = declared?.find((facet) => !known.includes(facet.name));
	if (stray !== undefined) {
		return {
			_tag: "Refused",
			reason: `\`triageFacets\` declares a facet \`${stray.name}\` the reconcile has no seat for — one of ${FACET_NAMES.join(", ")}. A facet nothing reconciles reads as configured and is not.`,
		};
	}
	const values = facetValues(board);
	const facets = FACET_NAMES.map((name): FacetVocabulary => {
		const declaredOwns = declared?.find((facet) => facet.name === name)?.owns;
		return {
			name,
			owns: declaredOwns ?? ownershipFor(name, values[name], key, shipped),
			values: values[name],
		};
	});
	const refusal = containmentRefusal(key, facets);
	return refusal === null ? {_tag: "Vocabulary", facets} : {_tag: "Refused", reason: refusal};
};
