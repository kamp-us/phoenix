/**
 * The verdict schema — the stable, dated, run-over-run-comparable shape the rite-audit
 * verdict report (#1516, epic #1510) aggregates the three rubric dimensions into.
 *
 * `Finding` and `DimensionResult` are the TS rendering of the dimension contract authored
 * in the rite-audit skill's `DIMENSIONS.md` (the single doc source of those shapes); the
 * explorer emits raw `Finding`s and unions them into `DimensionResult`s, and this package
 * structures them into one `Verdict`. The verdict's comparability rests on the **finding
 * key being the (dimension, check, surface) TRIPLE** — `check` alone collides across the
 * surfaces a dimension walks (a11y/#1514 and sandbox-leak/#1515 emit one finding per
 * (check, surface) pair), so the triple is what diffs cleanly run-over-run.
 */

/** A dimension-level (and overall) verdict is binary: any FAIL/BLOCKED finding fails it. */
export type Status = "PASS" | "FAIL";

/** A single finding's status. BLOCKED is never a pass — it rolls up as FAIL (DIMENSIONS.md). */
export type FindingStatus = "PASS" | "FAIL" | "BLOCKED";

/** The atom every rubric check emits — the DIMENSIONS.md `Finding` contract in TS. */
export interface Finding {
	readonly dimension: string;
	readonly check: string;
	readonly surface: string;
	readonly status: FindingStatus;
	readonly expected: string;
	readonly observed: string;
	readonly evidence: string;
}

/** What one dimension emits after running its rubric (DIMENSIONS.md `DimensionResult`). */
export interface DimensionResult {
	readonly dimension: string;
	readonly status: Status;
	readonly findings: ReadonlyArray<Finding>;
}

/** The run this verdict attests — the ephemeral audit stage the explorer walked. */
export interface VerdictTarget {
	readonly stage: string;
	readonly baseUrl: string;
}

/** One dimension's headline status, in the verdict's stable per-dimension roll-up. */
export interface PerDimensionStatus {
	readonly dimension: string;
	readonly status: Status;
}

/**
 * One dated run's verdict. The field order here IS the canonical serialization order
 * (`renderVerdictJson` relies on it), and `perDimension`/`findings` are sorted
 * deterministically by {@link buildVerdict} so two dated runs diff mechanically.
 */
export interface Verdict {
	readonly date: string; // ISO-8601 UTC run timestamp
	readonly target: VerdictTarget;
	readonly overall: Status;
	readonly perDimension: ReadonlyArray<PerDimensionStatus>;
	readonly findings: ReadonlyArray<Finding>;
}

/** The three canonical key fields of a finding — the comparison TRIPLE (#1516). */
export interface FindingKey {
	readonly dimension: string;
	readonly check: string;
	readonly surface: string;
}
