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
 */

/** The domain classification a triage decision assigns: one value per single-valued facet. */
export interface TriageClassification {
	readonly type: string;
	readonly priority: string;
	readonly status: string;
}

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
 * classification keeps.
 */
const FACETS: ReadonlyArray<{
	readonly owns: (label: string) => boolean;
	readonly desired: (classification: TriageClassification) => string;
}> = [
	{owns: (label) => label.startsWith(TYPE_PREFIX), desired: (c) => `${TYPE_PREFIX}${c.type}`},
	{owns: (label) => PRIORITY_RE.test(label), desired: (c) => c.priority},
	{
		owns: (label) =>
			label.startsWith(STATUS_PREFIX) && SPINE_STAGES.has(label.slice(STATUS_PREFIX.length)),
		desired: (c) => `${STATUS_PREFIX}${c.status}`,
	},
];

/** The labels a triaged entity must carry — exactly one per facet, in facet order. */
export const desiredLabels = (classification: TriageClassification): ReadonlyArray<string> =>
	FACETS.map((facet) => facet.desired(classification));

/**
 * The labels to remove so `current` converges on `classification`: every currently-carried label
 * that belongs to a facet but isn't that facet's desired member. Labels outside the three facets
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
