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

/** A single gate's verdict on a PR: PASS/FAIL, or null when that gate hasn't ruled. */
export const ReviewOutcome = Schema.Literals(["PASS", "FAIL"]);
export type ReviewOutcome = typeof ReviewOutcome.Type;

/**
 * The latest review verdict per namespace resolved from a PR's comments — the
 * format-5/6 markers in `.claude/skills/gh-issue-intake-formats.md`. `null` means
 * that gate has posted no PASS/FAIL marker yet; with an open PR present, both null
 * is the "awaiting review" state (never a false PASS/FAIL). This is the pure parse
 * core's output shape (`parseVerdict`).
 */
export interface ReviewVerdicts {
	readonly code: ReviewOutcome | null;
	readonly doc: ReviewOutcome | null;
}

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

/**
 * The merge-readiness verdict surfaced for an issue that has an open PR (#257).
 * Present only when an open PR is linked; `null` on the issue otherwise. `code` /
 * `doc` are the latest `review-code` / `review-doc` markers (null = that gate hasn't
 * ruled). With a PR present and both null, the UI shows "awaiting review" — an open
 * PR with no verdict never renders a false PASS/FAIL.
 */
export class IssueVerdict extends Schema.Class<IssueVerdict>(
	"@phoenix/dashboard/pipeline/IssueVerdict",
)({
	/** The open PR carrying (or awaiting) the verdict. */
	prNumber: Schema.Number,
	prUrl: Schema.String,
	code: Schema.NullOr(ReviewOutcome),
	doc: Schema.NullOr(ReviewOutcome),
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
	/** The gate verdict from a linked open PR, or null if the issue has none (#257). */
	verdict: Schema.NullOr(IssueVerdict),
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
	/** The gate verdict from a linked open PR, or null if the epic has none (#257). */
	verdict: Schema.NullOr(IssueVerdict),
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

/**
 * A cached `PipelineState` with its provenance: the parsed snapshot plus the
 * epoch-millis `fetchedAt` it was fetched from GitHub at. This is the value the
 * cache substrate persists (#254) — the snapshot the worker serves and the
 * timestamp the TTL/staleness decisions are made against.
 */
export class CachedPipelineState extends Schema.Class<CachedPipelineState>(
	"@phoenix/dashboard/pipeline/CachedPipelineState",
)({
	state: PipelineState,
	/** Epoch millis the snapshot was fetched from GitHub (the freshness anchor). */
	fetchedAt: Schema.Number,
}) {}

/** Round-trip a `CachedPipelineState` through the DO's JSON KV storage. */
export const encodeCachedPipelineState = Schema.encodeEffect(CachedPipelineState);
export const decodeCachedPipelineState = Schema.decodeUnknownEffect(CachedPipelineState);

/**
 * The pipeline-state API response (#254). FLAT by contract: the structured
 * state's `issues`/`epics` sit at the top level — NOT nested under `.state` —
 * alongside the freshness fields. The board's defensive reader
 * (`apps/dashboard/src/lib/pipeline.ts`, #274) reads `issues`/`epics` at the top
 * level with `fetchedAt`/`stale` as top-level optionals, so freshness is purely
 * additive over the #252 wire shape — adding the cache layer doesn't reshape the
 * response, it only annotates it.
 *
 * `stale` is `true` when GitHub was unreachable and the worker fell back to the
 * last good cached snapshot rather than erroring the whole board; `false` when
 * the snapshot is fresh — either a successful fetch or a cache hit within the
 * TTL. `fetchedAt` is the epoch-millis the served snapshot was fetched from
 * GitHub at.
 */
export class PipelineResponse extends Schema.Class<PipelineResponse>(
	"@phoenix/dashboard/pipeline/PipelineResponse",
)({
	issues: Schema.Array(PipelineIssue),
	epics: Schema.Array(PipelineEpic),
	fetchedAt: Schema.Number,
	stale: Schema.Boolean,
}) {}

/** Encode a `PipelineResponse` to its JSON wire form (validates the shape on the way out). */
export const encodePipelineResponse = Schema.encodeEffect(PipelineResponse);
