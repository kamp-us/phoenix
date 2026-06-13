/**
 * `@phoenix/epic-ledger` — the deterministic structural floor for an epic's
 * executable task ledger.
 *
 * The domain (`EpicLedger` / `ChildIssue` / `EpicHeader` / `Defect` /
 * `DefectType`) is `effect/Schema`; the validation surface (`validateLedger`,
 * `isPickable`, `ledgerSignature`) is a pure, deterministic function over a
 * decoded ledger; `decodeEpicLedger` is the GitHub trust boundary that lowers
 * untrusted REST JSON (and its `## Dependencies` / acceptance-criteria markdown)
 * into the domain. This package is the symmetric twin of `review-code` one stage
 * earlier — it gates `plan-epic`'s output before `write-code` picks children up.
 */
export {DEFECT_TYPES, Defect, DefectType, defectTypeRank} from "./Defect.ts";
export {decodeEpicLedger, GithubEpicInput} from "./github.ts";
export {findCycles} from "./graph.ts";
export {
	ChildIssue,
	DependencyEdge,
	DependencyGraph,
	EpicHeader,
	EpicLedger,
} from "./Ledger.ts";
export {countAcceptanceCriteria, parseDependencyGraph} from "./markdown.ts";
export {isPickable, ledgerSignature, validateLedger} from "./validate.ts";
