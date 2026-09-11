/**
 * The owned-facet reconcile that `triage apply` and `triage park` both write through, and the closed
 * vocabularies that feed it.
 *
 * A facet owns a pattern of labels and names the ones it keeps. **Every label the pattern matches and
 * the keep set does not is removed; every label no facet's pattern matches is preserved untouched.**
 * The milestone obeys the same rule — it is not a label, so it plans as its own change, but it is a
 * facet, which is what stops `--lane` from landing an issue on both a standing lane and a
 * milestone — a state the board does not have — while a labels-only read-back certifies it.
 *
 * **One engine, two verbs, deliberately.** The failure this engine exists to design out was a
 * *delete*, not a write: the priority facet owned `/^p\d+$/`, the applied `p2` was not in the keep
 * set, and a well-formed run
 * stripped the issue's only priority while printing a success line indistinguishable from a correct
 * one. Two independently-written reconciles are two chances to re-derive that, so the reconcile, the
 * change plan and the read-back assertion live here once and the verbs differ only in the facet table
 * they pass in.
 */
import {
	audienceLabel,
	type BoardVocabulary,
	classLabel,
	type FacetName,
	type ResolvedBoard,
	triageStatuses,
	typeLabel,
} from "../config/board.ts";
import {type FacetVocabulary, ownsLabel} from "../config/containment.ts";
import {DEFAULT_STATUS_NAMES} from "../labels.ts";
import {SHIP_CLASS_NAMES} from "../review/classes.ts";

/**
 * The two standing lanes, taking their values from the contract's `triage homes` table — the one
 * place in that spec that enumerates them.
 *
 * They live here only until `triage homes` lands and exports them; this list then moves to that
 * module and every reader re-points at it. It is defined in exactly one place even so: the contract's
 * own `park` facet table re-enumerates the same two labels as a regex, and a second copy is precisely
 * the drift a shared engine exists to prevent.
 */
export const STANDING_LANES: ReadonlyArray<string> = [
	"wayfinder:backlog",
	"axis:pipeline-hardening",
];

/**
 * The shipped default `--type` vocabulary, and the default of `boardVocabulary`'s `types`.
 *
 * Open, not closed: a repo declares its own and the compile-time narrowing goes with it. The refusal
 * survives as a runtime decode against the *resolved* list, which is what `decodeMember` is for.
 */
export const TYPES: ReadonlyArray<string> = [
	"bug",
	"feature",
	"chore",
	"decision",
	"investigation",
	"epic",
];

export {audienceLabel, classLabel, typeLabel};

/**
 * The `--class` vocabulary: the artifact classes a lane routes its shells off, as bare stems.
 *
 * Closed where {@link TYPES} is open, and read straight off `../review/classes.ts` rather than
 * re-typed here. A class the diff partition cannot raise is a class `review scope` and `ship scope`
 * would never agree with, so widening this set means widening that partition.
 */
export const CLASSES: ReadonlyArray<string> = SHIP_CLASS_NAMES;

/**
 * The type whose deliverable is a ledger of children rather than one pull request — as a bare
 * `--type` value, for the input-side reads that never see the label.
 */
export const EPIC_TYPE = "epic";

/**
 * The same type as the label a board carries.
 *
 * Three modules held their own copy of the string — `plan/load.ts`, `ledger/preconditions.ts` and
 * `build/scope-admission.ts` — the drift shape one derived constant closes. Derived from
 * {@link EPIC_TYPE}, so the bare value and the label cannot disagree.
 */
export const EPIC_TYPE_LABEL = typeLabel(EPIC_TYPE);

/** The default `--priority` vocabulary — the enum whose absence made `--p 1` mint a label `1`. */
export const PRIORITIES: ReadonlyArray<string> = ["p0", "p1", "p2"];

/** The default `--ready-for` vocabulary: who picks the issue up. */
export const AUDIENCES: ReadonlyArray<string> = ["human", "agent"];

/**
 * The shipped default of `boardVocabulary` — the board a repo that declared none reconciles to.
 *
 * Assembled from the lists above and `../labels.ts` rather than restated, so widening `TYPES`
 * widens what a bare repo accepts, bootstraps and reconciles in one edit.
 */
export const DEFAULT_BOARD_VOCABULARY: BoardVocabulary = {
	statuses: DEFAULT_STATUS_NAMES,
	types: TYPES,
	priorities: PRIORITIES,
	audiences: AUDIENCES,
	standingLanes: STANDING_LANES,
};

export const decodeMember = <A extends string>(
	vocabulary: ReadonlyArray<A>,
	value: string,
): A | null => (vocabulary.includes(value as A) ? (value as A) : null);

/** One facet: what it owns, and the labels it keeps of what it owns. */
export interface Facet {
	readonly name: string;
	readonly owns: (label: string) => boolean;
	readonly keep: ReadonlyArray<string>;
}

/**
 * The status facet owns the three statuses triage itself moves between, and no more. `status:planned`
 * and `status:awaiting-release` are written by `plan`/`ledger` and `ship`, so triage preserves them
 * rather than reconciling them away.
 */
export const TRIAGE_STATUSES: ReadonlyArray<string> = triageStatuses(DEFAULT_STATUS_NAMES);

/**
 * What each facet owns and every label an input can make it keep — the containment vocabulary, as
 * data.
 *
 * The `owns` predicates below are *derived* from this table rather than written beside it, so the
 * ownership a facet exercises and the ownership the containment check reads cannot drift apart. That
 * is also what makes the check meaningful once the vocabulary is configuration: this array is the
 * `triageFacets` key's shipped default (`../config/keys/triage-facets.ts`), so what a bare repo
 * enforces and what a declaring repo enforces are one shape.
 *
 * The invariant itself lives at `../config/containment.ts`, which runs it at load.
 */
export const FACET_VOCABULARY: ReadonlyArray<FacetVocabulary> = [
	{name: "type", owns: {_tag: "Pattern", source: "^type:"}, values: TYPES.map(typeLabel)},
	{name: "priority", owns: {_tag: "Pattern", source: "^p\\d+$"}, values: [...PRIORITIES]},
	{name: "status", owns: {_tag: "Set", labels: TRIAGE_STATUSES}, values: TRIAGE_STATUSES},
	{
		name: "audience",
		owns: {_tag: "Pattern", source: "^ready-for:"},
		values: AUDIENCES.map(audienceLabel),
	},
	{name: "lane", owns: {_tag: "Set", labels: STANDING_LANES}, values: [...STANDING_LANES]},
	{name: "class", owns: {_tag: "Pattern", source: "^class:"}, values: CLASSES.map(classLabel)},
];

/**
 * The board a verb reconciles against when nothing resolved one — the shipped default.
 *
 * It is the default argument of both facet tables below rather than a fallback they compute, so a
 * caller that has not threaded the resolved board through gets today's behaviour, never an empty
 * table that owns nothing.
 */
export const DEFAULT_BOARD: ResolvedBoard = {
	board: DEFAULT_BOARD_VOCABULARY,
	facets: FACET_VOCABULARY,
};

/**
 * One facet's `owns` predicate off a resolved table.
 *
 * An absent name answers "owns nothing" rather than throwing: a facet with no delete authority
 * preserves labels instead of stripping them, and `../config/board.ts` is what fills all six seats
 * on every composed table — a throw here would be a second, worse enforcement of that same rule.
 */
const ownsIn = (
	vocabulary: ReadonlyArray<FacetVocabulary>,
	name: FacetName,
): ((label: string) => boolean) => {
	const declared = vocabulary.find((facet) => facet.name === name);
	return declared === undefined ? () => false : ownsLabel(declared.owns);
};

/**
 * The audience facet's keep set — empty for an epic asked for the agent audience.
 *
 * `ready-for:agent` on an epic is `check-epic-plan`'s statement that the ledger's floor came back
 * clean, and that gate is the flip's only owner; triage writing it too is the ambiguity the
 * `triage apply` section of `claude-plugins/fabrika/skills/triage/contract.md` records.
 *
 * The facet still **owns** `ready-for:*` here, so re-triaging an epic that a gate run had already
 * flipped strips the stamp rather than preserving it — re-classifying an epic sends it back through
 * the gate, which is the same ownership rule read the other way. `--ready-for human` is untouched on
 * every type: that is triage parking the epic for a person, a claim the gate never makes.
 */
export const audienceKeep = (type: string, readyFor: string): ReadonlyArray<string> =>
	type === EPIC_TYPE && readyFor === "agent" ? [] : [audienceLabel(readyFor)];

/**
 * The facet table for the triaged transition.
 *
 * The containment invariant, stated where a future editor adding a facet will read it: **the set of
 * values an input can produce must be a subset of what its facet owns.** `PRIORITIES` ⊂ `/^p\d+$/`,
 * `TYPES` ⊂ `type:*`, `AUDIENCES` ⊂ `ready-for:*`, `STANDING_LANES` ⊂ itself, `CLASSES` ⊂ `class:*`. Widening a pattern past
 * its input — which is what v1 did — is what makes a correct value look superseded.
 * `facets.unit.test.ts` re-derives the containment rather than trusting this note, and
 * {@link FACET_VOCABULARY} is what puts the same derivation on a loaded config.
 */
export const triagedFacets = (
	input: {
		readonly type: string;
		readonly priority: string;
		readonly readyFor: string;
		readonly lane: string | null;
		/** The artifact classes this run stamps — empty is a triage that names none. */
		readonly classes: ReadonlyArray<string>;
	},
	resolved: ResolvedBoard = DEFAULT_BOARD,
): ReadonlyArray<Facet> => [
	{name: "type", owns: ownsIn(resolved.facets, "type"), keep: [typeLabel(input.type)]},
	{name: "priority", owns: ownsIn(resolved.facets, "priority"), keep: [input.priority]},
	{
		name: "status",
		owns: ownsIn(resolved.facets, "status"),
		keep: [resolved.board.statuses.triaged],
	},
	{
		name: "audience",
		owns: ownsIn(resolved.facets, "audience"),
		keep: audienceKeep(input.type, input.readyFor),
	},
	{
		name: "lane",
		owns: ownsIn(resolved.facets, "lane"),
		keep: input.lane === null ? [] : [input.lane],
	},
	{
		name: "class",
		owns: ownsIn(resolved.facets, "class"),
		keep: input.classes.map(classLabel),
	},
];

/**
 * The facet table for a park: the same six facets, every keep set empty but the status.
 *
 * A parked issue carries no type, no priority, no audience, no lane, no class and no home — and a re-park, or a
 * park after an earlier `apply`, arrives already priced. Asserting the end state over only the two
 * labels the verb wrote would certify an issue reading both `status:triaged` and `status:needs-info`,
 * which corrupts every queue read downstream.
 */
export const parkedFacets = (resolved: ResolvedBoard = DEFAULT_BOARD): ReadonlyArray<Facet> => [
	{name: "type", owns: ownsIn(resolved.facets, "type"), keep: []},
	{name: "priority", owns: ownsIn(resolved.facets, "priority"), keep: []},
	{
		name: "status",
		owns: ownsIn(resolved.facets, "status"),
		keep: [resolved.board.statuses.needsInfo],
	},
	{name: "audience", owns: ownsIn(resolved.facets, "audience"), keep: []},
	{name: "lane", owns: ownsIn(resolved.facets, "lane"), keep: []},
	{name: "class", owns: ownsIn(resolved.facets, "class"), keep: []},
];

/**
 * The facet table for a kill: the status facet alone, keeping nothing.
 *
 * **One facet, deliberately.** A killed issue keeps its classification as history — the type,
 * priority, audience, lane and class it was read under are what make a closed issue legible to
 * whoever finds it later — so this table names none of them, and `planReconcile` therefore counts
 * every one of their labels as `preserved` rather than owned. Inheriting `parkedFacets` here would
 * strip all six and leave a closed issue with no record of what it was.
 *
 * What must go is the status: `status:needs-triage` on a closed issue makes every unfiltered count
 * over that label over-report the queue, and a kill after an earlier `apply` leaves `status:triaged`
 * saying the same false thing. The keep set is empty, so all three triage statuses are
 * planned as removals whichever one the issue arrived carrying.
 *
 * The home is not a facet, and a kill does not move it: the caller passes the observed milestone as
 * `home` on both the plan and the read-back assertion, so no milestone change is planned and none is
 * demanded.
 */
export const killedFacets = (resolved: ResolvedBoard = DEFAULT_BOARD): ReadonlyArray<Facet> => [
	{name: "status", owns: ownsIn(resolved.facets, "status"), keep: []},
];

/** One atomic write the plan will issue. `AddLabels` is one change because it is one API call. */
export type Change =
	| {readonly _tag: "SetMilestone"; readonly milestone: number}
	| {readonly _tag: "ClearMilestone"}
	| {readonly _tag: "RemoveLabel"; readonly label: string}
	| {readonly _tag: "AddLabels"; readonly labels: ReadonlyArray<string>};

/** An issue's facet-bearing state, as read and as read back. */
export interface Shape {
	readonly labels: ReadonlyArray<string>;
	readonly milestone: number | null;
}

export interface Plan {
	readonly changes: ReadonlyArray<Change>;
	readonly removed: ReadonlyArray<string>;
	readonly added: ReadonlyArray<string>;
	/** Every label no facet owns. Named so a test can bind to it: these must never be written. */
	readonly preserved: ReadonlyArray<string>;
}

/**
 * Plan the reconcile from the observed shape to the one the facets and `home` describe.
 *
 * The **milestone change comes first**, before the labels. The homing guard fires on the label event,
 * so stamping `status:triaged` ahead of the home opens a real window in which the issue is triaged
 * and un-homed and the guard reds on the happy path — and a guard that reds on correct work is one
 * people learn to ignore. Removals precede the single add batch for the same reason: a superseded
 * status label must not be readable alongside its replacement.
 */
export const planReconcile = (
	observed: Shape,
	facets: ReadonlyArray<Facet>,
	home: number | null,
): Plan => {
	const keep = new Set(facets.flatMap((facet) => facet.keep));
	const owned = (label: string): boolean => facets.some((facet) => facet.owns(label));

	const removed = observed.labels.filter((label) => owned(label) && !keep.has(label));
	const added = [...keep].filter((label) => !observed.labels.includes(label));
	const preserved = observed.labels.filter((label) => !owned(label));

	const milestone: ReadonlyArray<Change> =
		home === observed.milestone
			? []
			: home === null
				? [{_tag: "ClearMilestone"}]
				: [{_tag: "SetMilestone", milestone: home}];

	return {
		changes: [
			...milestone,
			...removed.map((label): Change => ({_tag: "RemoveLabel", label})),
			...(added.length === 0 ? [] : [{_tag: "AddLabels", labels: added} as const]),
		],
		removed,
		added,
		preserved,
	};
};

/**
 * The facets whose observed labels are not exactly their keep set, plus `"milestone"` when the home
 * does not match — the read-back's **positive** proof, in the one shape both verbs assert.
 *
 * An empty array means every facet was observed to hold exactly what it should, which is a different
 * claim from "no contradiction was seen": a read that cannot see the new state fails this, because
 * the required labels are then observably absent rather than merely unrefuted.
 */
export const shapeViolations = (
	observed: Shape,
	facets: ReadonlyArray<Facet>,
	home: number | null,
): ReadonlyArray<string> => {
	const wrong = facets
		.filter((facet) => {
			const seen = observed.labels.filter(facet.owns).slice().sort();
			const want = facet.keep.slice().sort();
			return seen.length !== want.length || seen.some((label, i) => label !== want[i]);
		})
		.map((facet) => facet.name);
	return observed.milestone === home ? wrong : [...wrong, "milestone"];
};

/** What the read-back actually saw, facet by facet — the `<observed>` of the exit-`9` message. */
export const renderShape = (observed: Shape, facets: ReadonlyArray<Facet>): string => {
	const perFacet = facets.map(
		(facet) => `${facet.name}=[${observed.labels.filter(facet.owns).join(", ")}]`,
	);
	return [
		...perFacet,
		`milestone=${observed.milestone === null ? "none" : observed.milestone}`,
	].join(", ");
};
