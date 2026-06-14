/**
 * The epic-ledger domain model as Effect Schema — the decoded, validated shape
 * the floor validator runs over.
 *
 * An `EpicLedger` is an epic's executable task ledger: the epic header (its own
 * issue number + labels + the `## Dependencies` topology parsed off its body),
 * plus the set of linked child issues, each carrying the structural facts the
 * floor checks (acceptance-criteria count, labels). The shape is deliberately
 * post-parse: markdown has already been lowered to a `DependencyGraph` and an
 * `acceptanceCriteriaCount`, so `validateLedger` is a pure function over data,
 * never a parser. Decoding GitHub JSON into this shape is the boundary
 * (`github.ts`); everything downstream is total over a decoded `EpicLedger`.
 */
import * as Schema from "effect/Schema";

/**
 * One `## Dependencies` edge: `child` must wait on `requires` (the upstream
 * issue). The graph is the set of these edges; phases lower to edges too — a
 * later-phase child with no explicit `requires:` gets an edge to every issue in
 * each earlier phase (the phase-boundary default), per the formats contract.
 */
export const DependencyEdge = Schema.Struct({
	child: Schema.Number,
	requires: Schema.Number,
});
export type DependencyEdge = (typeof DependencyEdge)["Type"];

/**
 * The epic's parsed `## Dependencies` topology. `present` records whether the
 * section existed at all (its absence is `MISSING_DEPS_SECTION`); `nodes` is the
 * set of issue numbers the section references; `edges` is the lowered gating
 * relation cycle-detection runs over.
 */
export const DependencyGraph = Schema.Struct({
	present: Schema.Boolean,
	nodes: Schema.Array(Schema.Number),
	edges: Schema.Array(DependencyEdge),
});
export type DependencyGraph = (typeof DependencyGraph)["Type"];

/**
 * A linked child issue, reduced to the structural facts the floor checks.
 * `stories` is the child's `**Stories:**` refs (the epic story numbers it
 * implements or unblocks), parsed off its body at the boundary. `undefined`
 * records a child with **no** `**Stories:**` line at all (the `MISSING_STORY`
 * case); an empty array records the explicit pure-infra marker (covers nothing
 * by design — not a defect).
 */
export const ChildIssue = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	labels: Schema.Array(Schema.String),
	acceptanceCriteriaCount: Schema.Number,
	stories: Schema.optional(Schema.Array(Schema.Number)),
});
export type ChildIssue = (typeof ChildIssue)["Type"];

/**
 * The epic issue itself: its number, its labels, its parsed topology, and the
 * story numbers it declares under `### User stories` (`stories`) — the set every
 * child must collectively cover (`UNCOVERED_STORY` flags one no child references).
 */
export const EpicHeader = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	labels: Schema.Array(Schema.String),
	dependencies: DependencyGraph,
	stories: Schema.Array(Schema.Number),
});
export type EpicHeader = (typeof EpicHeader)["Type"];

/**
 * An epic's full executable task ledger — header, linked children, and
 * `externalRefs`: the dependency targets the `## Dependencies` topology references
 * that are **not** linked children of this epic but **do** resolve to real issues
 * in the repo (a legitimate cross-epic gating edge — e.g. a CLI verb that
 * `requires:` a backend issue owned by another epic). This set is resolved at the
 * GitHub boundary (`github.ts`), never by parsing; it is empty for a
 * self-contained ledger. The pure floor flags a referenced non-child as
 * `DANGLING_DEP` only when it is absent from this set — so a real cross-epic
 * dependency is allowed through, while a typo'd or deleted ref still dangles.
 */
export const EpicLedger = Schema.Struct({
	epic: EpicHeader,
	children: Schema.Array(ChildIssue),
	externalRefs: Schema.Array(Schema.Number),
});
export type EpicLedger = (typeof EpicLedger)["Type"];
