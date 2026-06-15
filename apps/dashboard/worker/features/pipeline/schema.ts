/**
 * The wire shape of the pipeline-state API (`GET /api/pipeline`), as
 * `effect/Schema` (ADR 0027, `.patterns/effect-schema-validation.md`). GitHub's
 * REST responses are an external trust boundary, so the structured view the route
 * returns is validated against these schemas before it leaves the worker — a
 * malformed parse fails loudly here rather than shipping garbage to the SPA.
 *
 * The label/status/type/priority vocabulary mirrors the pipeline-labels table in
 * `.claude/skills/gh-issue-intake-formats.md`; `## Dependencies` topology mirrors
 * §1 of that contract (phases, parallel groups, `requires:` edges).
 */
import * as Schema from "effect/Schema";

/** The pipeline `status:*` states an issue can sit in (intake-formats §Pipeline labels). */
export const PipelineStatus = Schema.Literals(["needs-triage", "needs-info", "planned", "triaged"]);
export type PipelineStatus = typeof PipelineStatus.Type;

/** The issue `type:*` classes (intake-formats — six types). */
export const PipelineType = Schema.Literals([
	"feature",
	"chore",
	"bug",
	"decision",
	"investigation",
	"epic",
]);
export type PipelineType = typeof PipelineType.Type;

/** The `p*` priority buckets. */
export const PipelinePriority = Schema.Literals(["p0", "p1", "p2"]);
export type PipelinePriority = typeof PipelinePriority.Type;

/**
 * The typed fields lifted out of an issue's labels. Each is `NullOr` because an
 * issue may carry none of that namespace (a raw, not-yet-classified intake) — the
 * parse never invents a value the labels don't assert.
 */
export class ParsedLabels extends Schema.Class<ParsedLabels>(
	"@phoenix/dashboard/pipeline/ParsedLabels",
)({
	status: Schema.NullOr(PipelineStatus),
	type: Schema.NullOr(PipelineType),
	priority: Schema.NullOr(PipelinePriority),
}) {}

/** A `requires:` edge: the issue's own number gated on another issue's number. */
export class RequiresEdge extends Schema.Class<RequiresEdge>(
	"@phoenix/dashboard/pipeline/RequiresEdge",
)({
	from: Schema.Number,
	to: Schema.Number,
}) {}

/** One `### Phase N` of the `## Dependencies` topology — an ordered parallel group. */
export class DependencyPhase extends Schema.Class<DependencyPhase>(
	"@phoenix/dashboard/pipeline/DependencyPhase",
)({
	/** Phase ordinal as written (`### Phase 2` → 2). The sequential spine. */
	phase: Schema.Number,
	/** Issue numbers listed in this phase — a parallel group, no intra-phase order. */
	issues: Schema.Array(Schema.Number),
}) {}

/** The parsed `## Dependencies` topology: ordered phases + the flat set of `requires:` edges. */
export class DependencyTopology extends Schema.Class<DependencyTopology>(
	"@phoenix/dashboard/pipeline/DependencyTopology",
)({
	phases: Schema.Array(DependencyPhase),
	requires: Schema.Array(RequiresEdge),
}) {}

/** A single issue in the structured view: raw GitHub facts + the parsed label fields. */
export class PipelineIssue extends Schema.Class<PipelineIssue>(
	"@phoenix/dashboard/pipeline/PipelineIssue",
)({
	number: Schema.Number,
	title: Schema.String,
	state: Schema.Literals(["open", "closed"]),
	/** The raw label names, kept so a consumer can see anything the parse didn't model. */
	labels: Schema.Array(Schema.String),
	parsed: ParsedLabels,
}) {}

/**
 * An epic: a `PipelineIssue`'s fields plus the two relations only an epic carries —
 * its `sub_issues` children (by number) and the parsed `## Dependencies` topology
 * off its body. Modelled as a distinct class so "an epic always has children +
 * topology" is a type, not a convention an issue might or might not satisfy.
 */
export class PipelineEpic extends Schema.Class<PipelineEpic>(
	"@phoenix/dashboard/pipeline/PipelineEpic",
)({
	number: Schema.Number,
	title: Schema.String,
	state: Schema.Literals(["open", "closed"]),
	labels: Schema.Array(Schema.String),
	parsed: ParsedLabels,
	/** Child issue numbers from the `sub_issues` relation (the list endpoint, source of truth). */
	children: Schema.Array(Schema.Number),
	dependencies: DependencyTopology,
}) {}

/** The full structured pipeline state the route returns. */
export class PipelineState extends Schema.Class<PipelineState>(
	"@phoenix/dashboard/pipeline/PipelineState",
)({
	issues: Schema.Array(PipelineIssue),
	epics: Schema.Array(PipelineEpic),
}) {}

/** Encode a `PipelineState` to its JSON wire form (validates the shape on the way out). */
export const encodePipelineState = Schema.encodeEffect(PipelineState);
