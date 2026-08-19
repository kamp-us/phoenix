/**
 * The owned-facet reconcile that `triage apply` and `triage park` both write through, and the closed
 * vocabularies that feed it.
 *
 * A facet owns a pattern of labels and names the ones it keeps. **Every label the pattern matches and
 * the keep set does not is removed; every label no facet's pattern matches is preserved untouched.**
 * The milestone obeys the same rule — it is not a label, so it plans as its own change, but it is a
 * facet, which is what stops `--lane` from landing the milestone-on-a-standing-lane state ADR 0208
 * bans while a labels-only read-back certifies it.
 *
 * **One engine, two verbs, deliberately.** #4285's mechanism was a *delete*, not a write: the
 * priority facet owned `/^p\d+$/`, the applied `p2` was not in the keep set, and a well-formed run
 * stripped the issue's only priority while printing a success line indistinguishable from a correct
 * one. Two independently-written reconciles are two chances to re-derive that, so the reconcile, the
 * change plan and the read-back assertion live here once and the verbs differ only in the facet table
 * they pass in.
 */
import {NEEDS_INFO, NEEDS_TRIAGE, TRIAGED} from "../labels.ts";

/**
 * The two standing lanes, taking their values from the contract's `triage homes` table — the one
 * place in that spec that enumerates them.
 *
 * They live here only until `triage homes` lands and exports them; this list then moves to that
 * module and every reader re-points at it. It is defined in exactly one place even so: the contract's
 * own `park` facet table re-enumerates the same two labels as a regex, and a second copy is precisely
 * the drift a shared engine exists to prevent.
 */
export const STANDING_LANES = ["wayfinder:backlog", "axis:pipeline-hardening"] as const;

export type StandingLane = (typeof STANDING_LANES)[number];

export const isStandingLane = (label: string): label is StandingLane =>
	(STANDING_LANES as ReadonlyArray<string>).includes(label);

/** The closed `--type` vocabulary. A value off it is refused before any write, never applied. */
export const TYPES = ["bug", "feature", "chore", "decision", "investigation", "epic"] as const;
export type TriageType = (typeof TYPES)[number];

/** The label form of one type. Every `type:*` label the package writes or matches comes from here. */
export const typeLabel = (type: TriageType): string => `type:${type}`;

/**
 * The type whose deliverable is a ledger of children rather than one pull request.
 *
 * Three modules held their own copy of the string — `plan/load.ts`, `ledger/preconditions.ts` and
 * `build/scope-admission.ts` — which is the drift shape #5772 collapsed for the status and facet
 * vocabularies. Derived from {@link TYPES}, so the label and the vocabulary cannot disagree.
 */
export const EPIC_TYPE_LABEL = typeLabel("epic");

/** The closed `--priority` vocabulary — the enum whose absence made `--p 1` mint a label `1`. */
export const PRIORITIES = ["p0", "p1", "p2"] as const;
export type TriagePriority = (typeof PRIORITIES)[number];

/** The closed `--ready-for` vocabulary: who picks the issue up (#4780). */
export const AUDIENCES = ["human", "agent"] as const;
export type TriageAudience = (typeof AUDIENCES)[number];

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

const ownsType = (label: string): boolean => label.startsWith("type:");
const ownsPriority = (label: string): boolean => /^p\d+$/.test(label);
/**
 * The status facet owns the three statuses triage itself moves between, and no more. `status:planned`
 * and `status:awaiting-release` are written by `plan`/`ledger` and `ship`, so triage preserves them
 * rather than reconciling them away.
 */
export const TRIAGE_STATUSES: ReadonlyArray<string> = [NEEDS_TRIAGE, TRIAGED, NEEDS_INFO];

const ownsStatus = (label: string): boolean => TRIAGE_STATUSES.includes(label);
const ownsAudience = (label: string): boolean => label.startsWith("ready-for:");

/**
 * The facet table for the triaged transition.
 *
 * The containment invariant, stated where a future editor adding a facet will read it: **the set of
 * values an input can produce must be a subset of what its facet owns.** `PRIORITIES` ⊂ `/^p\d+$/`,
 * `TYPES` ⊂ `type:*`, `AUDIENCES` ⊂ `ready-for:*`, `STANDING_LANES` ⊂ itself. Widening a pattern past
 * its input — which is what v1 did — is what makes a correct value look superseded.
 * `facets.unit.test.ts` re-derives the containment rather than trusting this note.
 */
export const triagedFacets = (input: {
	readonly type: TriageType;
	readonly priority: TriagePriority;
	readonly readyFor: TriageAudience;
	readonly lane: StandingLane | null;
}): ReadonlyArray<Facet> => [
	{name: "type", owns: ownsType, keep: [typeLabel(input.type)]},
	{name: "priority", owns: ownsPriority, keep: [input.priority]},
	{name: "status", owns: ownsStatus, keep: [TRIAGED]},
	{name: "audience", owns: ownsAudience, keep: [`ready-for:${input.readyFor}`]},
	{name: "lane", owns: isStandingLane, keep: input.lane === null ? [] : [input.lane]},
];

/**
 * The facet table for a park: the same five facets, every keep set empty but the status.
 *
 * A parked issue carries no type, no priority, no audience, no lane and no home — and a re-park, or a
 * park after an earlier `apply`, arrives already priced. Asserting the end state over only the two
 * labels the verb wrote would certify an issue reading both `status:triaged` and `status:needs-info`,
 * which corrupts every queue read downstream.
 */
export const parkedFacets = (): ReadonlyArray<Facet> => [
	{name: "type", owns: ownsType, keep: []},
	{name: "priority", owns: ownsPriority, keep: []},
	{name: "status", owns: ownsStatus, keep: [NEEDS_INFO]},
	{name: "audience", owns: ownsAudience, keep: []},
	{name: "lane", owns: isStandingLane, keep: []},
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
