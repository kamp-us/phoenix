/**
 * The pure verdict core: aggregate per-dimension findings into one dated `Verdict`, and
 * diff two verdicts mechanically. No IO — the bin (`bin.ts`) does the file writes; this is
 * the unit-tested shape (`verdict.unit.test.ts`), the founder-seed/preview-seed idiom.
 */
import type {
	DimensionResult,
	Finding,
	FindingKey,
	FindingStatus,
	PerDimensionStatus,
	Status,
	Verdict,
} from "./schema.ts";

/** ASCII unit separator (U+001F) — joins the triple into one key string; cannot appear in field text. */
const KEY_SEP = String.fromCharCode(0x1f);

/** The (dimension, check, surface) TRIPLE that identifies a finding across runs (#1516). */
export const findingKey = (f: FindingKey): string =>
	`${f.dimension}${KEY_SEP}${f.check}${KEY_SEP}${f.surface}`;

/**
 * The dimension roll-up, recomputed from findings rather than trusting the incoming
 * `DimensionResult.status` — so the story-11 invariant (a broken rite is unmistakable)
 * holds even if a dimension mis-set its own headline. PASS iff EVERY finding is PASS; a
 * single FAIL or BLOCKED fails the dimension (DIMENSIONS.md).
 */
export const dimensionStatus = (findings: ReadonlyArray<Finding>): Status =>
	findings.every((f) => f.status === "PASS") ? "PASS" : "FAIL";

/** Lexicographic compare with a stable, locale-independent ordering. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Re-key a finding into the canonical field order so its JSON serialization is stable. */
const canonicalFinding = (f: Finding): Finding => ({
	dimension: f.dimension,
	check: f.check,
	surface: f.surface,
	status: f.status,
	expected: f.expected,
	observed: f.observed,
	evidence: f.evidence,
});

export interface BuildVerdictInput {
	readonly date: string;
	readonly target: Verdict["target"];
	readonly dimensions: ReadonlyArray<DimensionResult>;
}

/**
 * Aggregate the dimensions into one dated verdict. `perDimension` is sorted by dimension id
 * and `findings` by the (dimension, check, surface) triple, so the output is byte-stable for
 * a fixed input — the precondition that lets {@link diffVerdicts} compare two dated runs
 * mechanically. **Overall is FAIL iff ANY dimension is FAIL** (story 11).
 */
export const buildVerdict = (input: BuildVerdictInput): Verdict => {
	const perDimension: PerDimensionStatus[] = input.dimensions
		.map((d) => ({dimension: d.dimension, status: dimensionStatus(d.findings)}))
		.sort((a, b) => cmp(a.dimension, b.dimension));

	const overall: Status = perDimension.every((d) => d.status === "PASS") ? "PASS" : "FAIL";

	const findings = input.dimensions
		.flatMap((d) => d.findings)
		.map(canonicalFinding)
		.sort((a, b) => cmp(findingKey(a), findingKey(b)));

	return {date: input.date, target: input.target, overall, perDimension, findings};
};

export type FindingChange = "appeared" | "disappeared" | "status-changed" | "unchanged";
export type DimensionChange = "regressed" | "fixed" | "appeared" | "disappeared" | "unchanged";

export interface FindingDelta {
	readonly key: FindingKey;
	readonly change: FindingChange;
	readonly from?: FindingStatus;
	readonly to?: FindingStatus;
}

export interface DimensionDelta {
	readonly dimension: string;
	readonly change: DimensionChange;
	readonly from?: Status;
	readonly to?: Status;
}

export interface VerdictDiff {
	readonly overall: {readonly from: Status; readonly to: Status; readonly changed: boolean};
	readonly perDimension: ReadonlyArray<DimensionDelta>;
	readonly findings: ReadonlyArray<FindingDelta>;
}

const classifyDimension = (from: Status | undefined, to: Status | undefined): DimensionChange => {
	if (from === undefined) return "appeared";
	if (to === undefined) return "disappeared";
	if (from === to) return "unchanged";
	return from === "PASS" ? "regressed" : "fixed";
};

/**
 * The mechanical diff over the stable schema, keyed on the (dimension, check, surface)
 * triple — the comparability deliverable. A regression (a previously-PASS dimension now
 * FAIL, or a finding that flipped to FAIL/BLOCKED) is surfaced as a structured delta, so a
 * run-over-run trend is computable without re-running the audit.
 */
export const diffVerdicts = (prev: Verdict, curr: Verdict): VerdictDiff => {
	const prevDims = new Map(prev.perDimension.map((d) => [d.dimension, d.status]));
	const currDims = new Map(curr.perDimension.map((d) => [d.dimension, d.status]));
	const perDimension: DimensionDelta[] = [...new Set([...prevDims.keys(), ...currDims.keys()])]
		.sort(cmp)
		.map((dimension) => {
			const from = prevDims.get(dimension);
			const to = currDims.get(dimension);
			return {
				dimension,
				change: classifyDimension(from, to),
				...(from !== undefined && {from}),
				...(to !== undefined && {to}),
			};
		});

	const prevFindings = new Map(prev.findings.map((f) => [findingKey(f), f]));
	const currFindings = new Map(curr.findings.map((f) => [findingKey(f), f]));
	const findings: FindingDelta[] = [...new Set([...prevFindings.keys(), ...currFindings.keys()])]
		.sort(cmp)
		.map((k) => {
			const a = prevFindings.get(k);
			const b = currFindings.get(k);
			const src = a ?? b;
			const key: FindingKey = {
				dimension: src?.dimension ?? "",
				check: src?.check ?? "",
				surface: src?.surface ?? "",
			};
			if (a === undefined) return {key, change: "appeared", ...(b && {to: b.status})};
			if (b === undefined) return {key, change: "disappeared", from: a.status};
			if (a.status === b.status) return {key, change: "unchanged", from: a.status, to: b.status};
			return {key, change: "status-changed", from: a.status, to: b.status};
		});

	return {
		overall: {from: prev.overall, to: curr.overall, changed: prev.overall !== curr.overall},
		perDimension,
		findings,
	};
};
