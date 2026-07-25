/**
 * The triage label contract as a pure, IO-free decision: which labels a triaged entity must
 * carry, and which of the ones it already carries are *superseded* by that classification.
 *
 * A triaged entity carries EXACTLY ONE label per facet — one `type:*`, one priority, one
 * `status:*` spine stage (the triage skill's Step 6 contract). Modeling the facets as a fixed record makes
 * a two-priority desired state unrepresentable, and turns the transition into a **convergent
 * reconcile** rather than an additive one: every label in a facet that isn't the desired one is
 * superseded and removed. The re-prioritize path used to be additive, so `p1` landed alongside
 * the old `p2` and left the queue's pick order ambiguous (#3771).
 *
 * The queue-label drop (`status:needs-triage`) is not a special case here — it is just the
 * status facet's instance of the same rule.
 *
 * Triage has TWO outcomes, not one: a `classified` issue carries all three facets, and a `parked`
 * one (`status:needs-info`) carries a status and *deliberately* no type and no priority — the
 * triage skill's Step 5 contract, "not a type, not a priority, not triaged". Modeling them as one
 * record with three required facets made the park inexpressible, so the verb minted a filler
 * `type:`/`p*` for an issue triage had explicitly declined to classify (#4042, observed on #4067).
 */

/**
 * The domain classification a triage decision assigns. The two arms make the invalid combination
 * — an un-classified stage carrying a type or a priority — unrepresentable rather than merely
 * unchecked; `classify` is the only way in, and it is total.
 */
export type TriageClassification =
	| {
			readonly _tag: "classified";
			readonly type: string;
			readonly priority: string;
			readonly status: string;
	  }
	| {readonly _tag: "parked"; readonly status: string};

/** A judgment the contract refuses, carrying the reason a caller must surface. */
export interface InvalidClassification {
	readonly _tag: "invalid";
	readonly reason: string;
}

/**
 * The lifecycle stages that are *defined* as un-classified: the entity is parked pending an
 * answer, so a type or a priority on it would be a fabrication, not a judgment (triage skill
 * Step 5). Every other stage is a real classification and needs both facets.
 */
const UNCLASSIFIED_STAGES: ReadonlySet<string> = new Set(["needs-info"]);

const supplied = (value: string | undefined): string | null => {
	const trimmed = value?.trim() ?? "";
	return trimmed === "" ? null : trimmed;
};

/**
 * The one way to build a `TriageClassification` from a caller's judgment: it routes on the target
 * stage and rejects the two ill-formed shapes — a park that supplies facets, and a classification
 * that omits them.
 */
export const classify = (judgment: {
	readonly type?: string | undefined;
	readonly priority?: string | undefined;
	readonly status: string;
}): TriageClassification | InvalidClassification => {
	const status = judgment.status.trim();
	const type = supplied(judgment.type);
	const priority = supplied(judgment.priority);

	if (UNCLASSIFIED_STAGES.has(status)) {
		const offered = [type === null ? null : `type ${type}`, priority === null ? null : priority]
			.filter((facet) => facet !== null)
			.join(" and ");
		return offered === ""
			? {_tag: "parked", status}
			: {
					_tag: "invalid",
					reason: `status:${status} parks an entity with no type and no priority, but this judgment supplies ${offered} — drop them, or target a classified stage`,
				};
	}

	if (type === null || priority === null) {
		const missing = [type === null ? "type" : null, priority === null ? "priority" : null]
			.filter((facet) => facet !== null)
			.join(" and ");
		return {
			_tag: "invalid",
			reason: `status:${status} is a classified stage and requires both a type and a priority — missing ${missing}`,
		};
	}

	return {_tag: "classified", type, priority, status};
};

// A priority label is the bare bucket name (`p0`/`p1`/`p2`); `\d+` rather than a closed set so a
// future bucket is reconciled too instead of silently surviving as a second priority.
const PRIORITY_RE = /^p\d+$/;

const TYPE_PREFIX = "type:";
const STATUS_PREFIX = "status:";

// The status facet is the PICKABILITY SPINE — the pipeline states an issue moves *between* —
// enumerated, never the whole `status:` prefix. Other labels live in that namespace but sit
// ALONGSIDE the spine rather than on it: `status:awaiting-release` is a post-merge release-queue
// marker (`ship-it` queues it, `release` resolves a flag to its issue by querying it), and
// `status:planning` is a transient epic-lock held next to an epic's real status. Owning the raw
// prefix would supersede those on any re-prioritize, silently ejecting a dark-shipped issue from
// the human release queue. Source of the set: the Pipeline-labels table in
// `claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md`.
const SPINE_STAGES: ReadonlySet<string> = new Set([
	"needs-triage",
	"needs-info",
	"planned",
	"triaged",
]);

/**
 * The single-valued label families. `owns` decides membership from the label name alone (so a
 * label the tracker never applied is still reconciled), `desired` names the one member the
 * classification keeps — or `null` when it desires *no* member of that facet, which the
 * convergent reconcile reads as "supersede every member": parking to `needs-info` strips a stale
 * `type:*`/`p*` rather than leaving the entity classified on a stage defined as un-classified.
 */
const FACETS: ReadonlyArray<{
	readonly owns: (label: string) => boolean;
	readonly desired: (classification: TriageClassification) => string | null;
}> = [
	{
		owns: (label) => label.startsWith(TYPE_PREFIX),
		desired: (c) => (c._tag === "classified" ? `${TYPE_PREFIX}${c.type}` : null),
	},
	{
		owns: (label) => PRIORITY_RE.test(label),
		desired: (c) => (c._tag === "classified" ? c.priority : null),
	},
	{
		owns: (label) =>
			label.startsWith(STATUS_PREFIX) && SPINE_STAGES.has(label.slice(STATUS_PREFIX.length)),
		desired: (c) => `${STATUS_PREFIX}${c.status}`,
	},
];

/** The labels the classification must carry — at most one per facet, in facet order. */
export const desiredLabels = (classification: TriageClassification): ReadonlyArray<string> =>
	FACETS.map((facet) => facet.desired(classification)).filter(
		(label): label is string => label !== null,
	);

/**
 * The labels to remove so `current` converges on `classification`: every currently-carried label
 * that belongs to a facet but isn't that facet's desired member — which, for a facet the
 * classification desires nothing from (a park's type/priority), is every member it carries.
 * Labels outside the three facets
 * (`epic`, `good first issue`, an orthogonal `status:awaiting-release`, …) are never touched —
 * this is the narrow triage contract, not a
 * general label reconciler. De-duplicated and idempotent: on an entity already in the contract's
 * shape it is empty, so a re-run of the same classification removes nothing.
 */
export const supersededLabels = (
	current: ReadonlyArray<string>,
	classification: TriageClassification,
): ReadonlyArray<string> => {
	const keep = new Set(desiredLabels(classification));
	return [
		...new Set(
			current.filter((label) => !keep.has(label) && FACETS.some((facet) => facet.owns(label))),
		),
	];
};
