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

/** A linked child issue, reduced to the structural facts the floor checks. */
export const ChildIssue = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	labels: Schema.Array(Schema.String),
	acceptanceCriteriaCount: Schema.Number,
});
export type ChildIssue = (typeof ChildIssue)["Type"];

/** The epic issue itself: its number, its labels, and its parsed topology. */
export const EpicHeader = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	labels: Schema.Array(Schema.String),
	dependencies: DependencyGraph,
});
export type EpicHeader = (typeof EpicHeader)["Type"];

/** An epic's full executable task ledger — header plus its linked children. */
export const EpicLedger = Schema.Struct({
	epic: EpicHeader,
	children: Schema.Array(ChildIssue),
});
export type EpicLedger = (typeof EpicLedger)["Type"];
