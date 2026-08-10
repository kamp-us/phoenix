/**
 * The eval graded oracle — the per-corpus-entry quality grade (issue #1849, epic #1842).
 *
 * ADR 0112 §3 defines a per-stage output-quality oracle: a reproducible pass/fail that asserts
 * an optimized stage reproduced the SAME decision artifact as the baseline. That oracle is
 * binary over ONE frozen input. This module generalizes it to grade EACH corpus entry —
 * `gradeEntry` scores one entry's actual run `artifact` against its known-good `label`, so a
 * pass-RATE can later be computed over the whole corpus (the report slice, #1853). See ADR 0112 §3.
 *
 * Two invariants hold, matching the corpus core's `decodeManifest` discipline:
 *  - Pure + total. The artifact is collected out-of-band by the runner slice (#1851), so it
 *    arrives here as `unknown`; a malformed or absent artifact grades `fail` with a stated
 *    reason, never throws.
 *  - A fail carries the observed-vs-expected mismatch (not a bare boolean), so the report can
 *    attribute WHY a (stage × model) missed.
 */
import {Result} from "effect";
import * as Schema from "effect/Schema";
import {type CorpusEntry, type ReviewSurface, SKILL_RIGOR_CHECKS} from "./corpus.ts";

/** A single field's disagreement between the observed artifact and the expected label. */
export interface FieldMismatch {
	readonly field: string;
	readonly observed: string;
	readonly expected: string;
}

/** Why an entry graded `fail` — an unusable artifact, or a per-field label disagreement. */
export type Mismatch =
	| {readonly _tag: "MalformedArtifact"; readonly reason: string}
	| {readonly _tag: "LabelMismatch"; readonly fields: ReadonlyArray<FieldMismatch>};

/** One entry's grade: `pass`, or `fail` carrying the attributable mismatch. */
export type Grade =
	| {readonly status: "pass"}
	| {readonly status: "fail"; readonly mismatch: Mismatch};

const pass: Grade = {status: "pass"};

const failMalformed = (reason: string): Grade => ({
	status: "fail",
	mismatch: {_tag: "MalformedArtifact", reason},
});

// Empty field set ⇒ nothing disagreed ⇒ pass; otherwise fail with the collected disagreements.
const gradeFields = (fields: ReadonlyArray<FieldMismatch>): Grade =>
	fields.length === 0 ? pass : {status: "fail", mismatch: {_tag: "LabelMismatch", fields}};

/** Scalar equality — a stringified observed/expected pair when they differ, else nothing. */
const cmpScalar = (
	field: string,
	observed: unknown,
	expected: unknown,
): ReadonlyArray<FieldMismatch> =>
	observed === expected ? [] : [{field, observed: String(observed), expected: String(expected)}];

// ADR 0112 §3 grades a finding SET, not an ordered list — dedup + sort so order and repeats
// don't spuriously flip a grade.
const canonicalSet = (xs: ReadonlyArray<string>): ReadonlyArray<string> =>
	Array.from(new Set(xs)).sort();

const cmpSet = (
	field: string,
	observed: ReadonlyArray<string>,
	expected: ReadonlyArray<string>,
): ReadonlyArray<FieldMismatch> => {
	const o = canonicalSet(observed);
	const e = canonicalSet(expected);
	const equal = o.length === e.length && o.every((v, i) => v === e[i]);
	return equal ? [] : [{field, observed: JSON.stringify(o), expected: JSON.stringify(e)}];
};

// Artifact schemas mirror each stage's frozen label shape in corpus.ts (#1848) — and, for `review`,
// each SURFACE's, since that is the level the label shape is fixed at (ADR 0243 §1). The OBSERVED
// decision artifact is the same shape as the EXPECTED label. Kept separate (not exported from
// corpus.ts) because artifact and label are distinct concepts sharing a shape, not one type.
const Verdict = Schema.Literals(["PASS", "FAIL"]);
const Priority = Schema.Literals(["p0", "p1", "p2"]);

const TriageArtifact = Schema.Struct({
	type: Schema.String,
	priority: Priority,
	status: Schema.String,
});
const BuildArtifact = Schema.Struct({
	fixesRef: Schema.Int,
	ciGreen: Schema.Boolean,
	reviewVerdict: Verdict,
});
const ReviewCodeArtifact = Schema.Struct({
	verdict: Verdict,
	acFindings: Schema.Array(Schema.String),
});
const ReviewDocArtifact = Schema.Struct({
	verdict: Verdict,
	findings: Schema.Array(Schema.String),
});
const ReviewSkillArtifact = Schema.Struct({
	verdict: Verdict,
	rigorFindings: Schema.Array(
		Schema.Struct({
			check: Schema.Literals([...SKILL_RIGOR_CHECKS]),
			finding: Schema.String,
		}),
	),
});
const ShipItArtifact = Schema.Struct({
	merged: Schema.Boolean,
	mergeSha: Schema.String,
});

const decodeTriage = Schema.decodeUnknownResult(TriageArtifact);
const decodeBuild = Schema.decodeUnknownResult(BuildArtifact);
const decodeReviewCode = Schema.decodeUnknownResult(ReviewCodeArtifact);
const decodeReviewDoc = Schema.decodeUnknownResult(ReviewDocArtifact);
const decodeReviewSkill = Schema.decodeUnknownResult(ReviewSkillArtifact);
const decodeShipIt = Schema.decodeUnknownResult(ShipItArtifact);

// Narrow `entry.label` by discriminating on `entry.stage` (CorpusEntry is a union on `stage`).
type LabelOf<S extends CorpusEntry["stage"]> = Extract<CorpusEntry, {stage: S}>["label"];

// The `review` stage carries a second discriminator, so its label narrows on the PAIR. Selecting a
// review grader on `stage` alone is banned (ADR 0243 §2): it collapses three rubrics onto one.
type ReviewLabelOf<S extends ReviewSurface> = Extract<
	CorpusEntry,
	{stage: "review"; surface: S}
>["label"];

// See ADR 0112 §3 for every oracle definition below — do not re-invent a rubric.

/** triage passes iff the actual `{type, priority, status}` equals the label (ADR 0112 §3). */
const gradeTriage = (label: LabelOf<"triage">, artifact: unknown): Grade => {
	const decoded = decodeTriage(artifact);
	if (Result.isFailure(decoded))
		return failMalformed(`triage artifact: ${decoded.failure.message}`);
	const a = decoded.success;
	return gradeFields([
		...cmpScalar("type", a.type, label.type),
		...cmpScalar("priority", a.priority, label.priority),
		...cmpScalar("status", a.status, label.status),
	]);
};

/**
 * build passes iff the PR carries the labeled `Fixes #N` + CI green + an independent
 * `review-code: PASS` — i.e. the actual `{fixesRef, ciGreen, reviewVerdict}` equals the label
 * (ADR 0112 §3). The recorded v1 `write-code` rows share this label shape, so they grade here too.
 */
const gradeBuild = (label: LabelOf<"build">, artifact: unknown): Grade => {
	const decoded = decodeBuild(artifact);
	if (Result.isFailure(decoded)) return failMalformed(`build artifact: ${decoded.failure.message}`);
	const a = decoded.success;
	return gradeFields([
		...cmpScalar("fixesRef", a.fixesRef, label.fixesRef),
		...cmpScalar("ciGreen", a.ciGreen, label.ciGreen),
		...cmpScalar("reviewVerdict", a.reviewVerdict, label.reviewVerdict),
	]);
};

/**
 * The `code` surface passes iff the actual verdict + AC-finding set match the label (ADR 0112 §3).
 * The recorded v1 `review-code` rows share this label shape, so they grade here too.
 */
const gradeReviewCode = (label: ReviewLabelOf<"code">, artifact: unknown): Grade => {
	const decoded = decodeReviewCode(artifact);
	if (Result.isFailure(decoded))
		return failMalformed(`review-code artifact: ${decoded.failure.message}`);
	const a = decoded.success;
	return gradeFields([
		...cmpScalar("verdict", a.verdict, label.verdict),
		...cmpSet("acFindings", a.acFindings, label.acFindings),
	]);
};

/** The `doc` surface passes iff the actual verdict + doc-finding set match the label (ADR 0112 §3). */
const gradeReviewDoc = (label: ReviewLabelOf<"doc">, artifact: unknown): Grade => {
	const decoded = decodeReviewDoc(artifact);
	if (Result.isFailure(decoded))
		return failMalformed(`review-doc artifact: ${decoded.failure.message}`);
	const a = decoded.success;
	return gradeFields([
		...cmpScalar("verdict", a.verdict, label.verdict),
		...cmpSet("findings", a.findings, label.findings),
	]);
};

// A rigor finding is a (check, finding) pair, so the set it belongs to is a set of pairs. Rendering
// each as `check: finding` makes the comparison the same set-equality the other surfaces get while
// keeping the mismatch readable; the check names are a closed vocabulary with no `: `, so the
// rendering is injective.
const renderRigorFinding = (f: {readonly check: string; readonly finding: string}): string =>
	`${f.check}: ${f.finding}`;

/**
 * The `skill` surface passes iff the actual verdict + rigor-finding set match the label, where a
 * finding is graded together with the rubric check it was attributed to — a right finding filed
 * under the wrong check is a miss, which is the attribution the pair label exists to hold
 * (ADR 0243 §1a).
 */
const gradeReviewSkill = (label: ReviewLabelOf<"skill">, artifact: unknown): Grade => {
	const decoded = decodeReviewSkill(artifact);
	if (Result.isFailure(decoded))
		return failMalformed(`review-skill artifact: ${decoded.failure.message}`);
	const a = decoded.success;
	return gradeFields([
		...cmpScalar("verdict", a.verdict, label.verdict),
		...cmpSet(
			"rigorFindings",
			a.rigorFindings.map(renderRigorFinding),
			label.rigorFindings.map(renderRigorFinding),
		),
	]);
};

/**
 * Select a `review` entry's grader by its `surface`. This second narrowing is the whole point of
 * ADR 0243: with one `review` stage and no further key, the three rubrics would collapse onto one
 * grader silently. Each surface reaches its own grader and its own artifact schema.
 */
const gradeReview = (entry: Extract<CorpusEntry, {stage: "review"}>, artifact: unknown): Grade => {
	switch (entry.surface) {
		case "code":
			return gradeReviewCode(entry.label, artifact);
		case "doc":
			return gradeReviewDoc(entry.label, artifact);
		case "skill":
			return gradeReviewSkill(entry.label, artifact);
	}
};

/** ship-it passes iff the actual `{merged, mergeSha}` equals the label (ADR 0112 §3). */
const gradeShipIt = (label: LabelOf<"ship-it">, artifact: unknown): Grade => {
	const decoded = decodeShipIt(artifact);
	if (Result.isFailure(decoded))
		return failMalformed(`ship-it artifact: ${decoded.failure.message}`);
	const a = decoded.success;
	return gradeFields([
		...cmpScalar("merged", a.merged, label.merged),
		...cmpScalar("mergeSha", a.mergeSha, label.mergeSha),
	]);
};

/**
 * Grade one corpus entry's actual run `artifact` against its known-good `label`. Pure + total:
 * the grader is selected by the entry's `stage` discriminator — and, for `review`, by the
 * `(stage, surface)` pair (ADR 0243 §2) — and an artifact that fails its shape grades `fail` with a
 * stated reason rather than throwing. See ADR 0112 §3.
 */
export const gradeEntry = (entry: CorpusEntry, artifact: unknown): Grade => {
	switch (entry.stage) {
		case "triage":
			return gradeTriage(entry.label, artifact);
		case "build":
		case "write-code":
			return gradeBuild(entry.label, artifact);
		case "review":
			return gradeReview(entry, artifact);
		case "review-code":
			return gradeReviewCode(entry.label, artifact);
		case "review-doc":
			return gradeReviewDoc(entry.label, artifact);
		case "ship-it":
			return gradeShipIt(entry.label, artifact);
	}
};
