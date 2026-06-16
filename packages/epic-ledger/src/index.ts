/**
 * `@kampus/epic-ledger` — the deterministic structural floor for an epic's
 * executable task ledger.
 *
 * The domain (`EpicLedger` / `ChildIssue` / `EpicHeader` / `Defect` /
 * `DefectType`) is `effect/Schema`; the validation surface (`validateLedger`,
 * `isPickable`, `ledgerSignature`) is a pure, deterministic function over a
 * decoded ledger; `decodeEpicLedger` is the GitHub trust boundary that lowers
 * untrusted REST JSON (and its `## Dependencies` / `### User stories` /
 * acceptance-criteria / `**Stories:**` markdown) into the domain, and `Github` is
 * the live capability that reads one by shelling `gh api` REST. On top of that
 * floor sit the gate and the loop: `runGate` is the deterministic `review-plan`
 * gate action (validate → flip `status:planned → triaged` on a clean ledger, or
 * post a per-defect FAIL and flip nothing), and `runConvergenceLoop` drives an
 * epic to a clean gate by re-planning while the hard-defect set strictly shrinks,
 * parking at `status:needs-info` on a stall (ADR 0047). This package is the
 * symmetric twin of `review-code` one stage earlier — it gates `plan-epic`'s
 * output before `write-code` picks children up.
 */
export {DEFECT_TYPES, Defect, DefectType, defectTypeRank} from "./Defect.ts";
export {type GateError, type GateVerdict, runGate, VERDICT_MARKERS} from "./gate.ts";
export {
	decodeEpicLedger,
	GhCommandError,
	GhParseError,
	Github,
	GithubEpicInput,
	GithubLive,
	RepoResolutionError,
} from "./github.ts";
export {findCycles} from "./graph.ts";
export {
	ChildIssue,
	DependencyEdge,
	DependencyGraph,
	EpicHeader,
	EpicLedger,
} from "./Ledger.ts";
export {
	DEFAULT_CEILING,
	type LoopOutcome,
	RePlanError,
	RePlanner,
	runConvergenceLoop,
	type StallReason,
} from "./loop.ts";
export {
	countAcceptanceCriteria,
	parseChildStories,
	parseDependencyGraph,
	parseEpicStories,
} from "./markdown.ts";
export {isPickable, ledgerSignature, validateLedger} from "./validate.ts";
