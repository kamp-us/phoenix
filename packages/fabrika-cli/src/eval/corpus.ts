/**
 * `eval` corpus core — the typed data model + on-disk format for the graded
 * per-stage ground truth (issue #1848, epic #1842).
 *
 * The token-economics apparatus (ADR 0112) grades one frozen input per stage with a
 * binary oracle — enough for a deterministic lever flip, not for a stochastic model
 * swap. This module is the shared core every later slice reads and writes: a labeled
 * *corpus* per stage, the graded generalization of ADR 0112 §1's single frozen input
 * into a version-controlled ground truth. See ADR 0112.
 *
 * The one non-obvious shape: a corpus entry is a **discriminated union keyed on `stage`**,
 * so a label whose shape doesn't match its stage is *unrepresentable* — the build
 * label `{fixesRef, ciGreen, reviewVerdict}` cannot sit under `stage: "triage"`, whose
 * only admissible label is `{type, priority, status}` (make-invalid-states-unrepresentable).
 * The manifest doubles the guarantee: it groups entries under per-stage keys whose value
 * schema is that stage's entry alone, so a mismatched entry can't even be filed. The single
 * `review` stage extends that guarantee one level down: it discriminates again on `surface`,
 * so the guarantee holds over the `(stage, surface)` pair. See ADR 0243.
 *
 * The second non-obvious shape: an entry's `stage` is **recorded provenance** — what actually
 * produced the row — while a manifest's group key is the **live stage**. The two are the same
 * for anything measured from now on and differ for the v1 rows the harness already carries.
 * See the founder ruling on #4977.
 *
 * `decodeManifest` is total — it returns a typed `Result` failure on malformed JSON or a
 * schema mismatch, never a throw.
 */
import {Result} from "effect";
import * as Schema from "effect/Schema";

/** The live stage vocabulary: what `--stage` accepts and what a manifest groups entries under. */
export const STAGES = ["triage", "build", "review", "ship-it"] as const;

/** One live stage key. Distinct from an entry's `stage`, which may be a recorded v1 name. */
export type LiveStage = (typeof STAGES)[number];

/**
 * The review surfaces the one `review` stage fans into (ADR 0243 §1) — the axis that selects
 * both a review entry's label shape and its grader.
 */
export const REVIEW_SURFACES = ["code", "doc", "skill"] as const;

/** One review surface — the sub-discriminator of the `review` stage. */
export type ReviewSurface = (typeof REVIEW_SURFACES)[number];

/**
 * The skill rubric's four rigor checks, as a closed vocabulary, in the order
 * `claude-plugins/fabrika/skills/review/rubrics/skill.md` numbers them. The rubric's fifth
 * candidate — gate-invariant preservation — is absent on purpose: that check is the `governance`
 * skill's and the rubric says it is "never graded here", so a corpus row cannot attribute a
 * finding to it. See ADR 0243 §1a.
 */
export const SKILL_RIGOR_CHECKS = [
	"behavioral-correctness",
	"trigger-description-quality",
	"cross-skill-conflict",
	"fabrika-conventions",
] as const;

/** One rigor check of the skill rubric. */
export type SkillRigorCheck = (typeof SKILL_RIGOR_CHECKS)[number];

/** A reproducible input identifier — an issue/PR number (ADR 0112 §1: pinned by identifier). */
const InputRef = Schema.Int;

/** A gate verdict — the two authorized outcomes of a review/ship marker. */
const Verdict = Schema.Literals(["PASS", "FAIL"]);

/** A triage priority bucket. */
const Priority = Schema.Literals(["p0", "p1", "p2"]);

/** triage's known-good decision artifact: the type/priority/status the stage assigns. */
const TriageEntry = Schema.Struct({
	stage: Schema.Literal("triage"),
	inputRef: InputRef,
	label: Schema.Struct({
		type: Schema.String,
		priority: Priority,
		status: Schema.String,
	}),
});

/** build's oracle: the issue it fixes, a green CI, and the review verdict its PR earned. */
const BuildLabel = Schema.Struct({
	fixesRef: InputRef,
	ciGreen: Schema.Boolean,
	reviewVerdict: Verdict,
});

const BuildEntry = Schema.Struct({
	stage: Schema.Literal("build"),
	inputRef: InputRef,
	label: BuildLabel,
});

/**
 * A row the v1 `write-code` stage recorded, under the same label shape `build` now records.
 * Its key stays `write-code` because that is what ran — a recorded stage key is provenance, not
 * a pointer into the live vocabulary, and re-keying it would republish a v1 measurement as a
 * fabrika one. See the founder ruling on #4977. Nothing new may be filed under it; the live key
 * `build` is what a manifest groups both under.
 */
const RecordedWriteCodeEntry = Schema.Struct({
	stage: Schema.Literal("write-code"),
	inputRef: InputRef,
	label: BuildLabel,
});

/** The code surface's oracle: the verdict plus the acceptance-criteria findings it surfaced. */
const ReviewCodeLabel = Schema.Struct({
	verdict: Verdict,
	acFindings: Schema.Array(Schema.String),
});

/** The doc surface's oracle: the verdict plus the doc findings it surfaced. */
const ReviewDocLabel = Schema.Struct({
	verdict: Verdict,
	findings: Schema.Array(Schema.String),
});

/**
 * The skill surface's oracle: the verdict plus findings that each name the rigor check they came
 * from. This surface's rubric is the only one of the three whose checks are a numbered, closed set,
 * so a flat `Array(String)` would throw away an attribution the source already carries — and would
 * leave the rubric's governance exclusion unexpressible. See ADR 0243 §1a for the derivation.
 */
const ReviewSkillLabel = Schema.Struct({
	verdict: Verdict,
	rigorFindings: Schema.Array(
		Schema.Struct({
			check: Schema.Literals([...SKILL_RIGOR_CHECKS]),
			finding: Schema.String,
		}),
	),
});

/**
 * The `review` stage's three members, each pinning `surface` to a literal and admitting exactly one
 * label shape. `surface` is required and has no default: a `review` entry with no surface is a
 * decode failure, never a row a fallback rubric grades (ADR 0243 §1).
 */
const ReviewCodeEntry = Schema.Struct({
	stage: Schema.Literal("review"),
	surface: Schema.Literal("code"),
	inputRef: InputRef,
	label: ReviewCodeLabel,
});

const ReviewDocEntry = Schema.Struct({
	stage: Schema.Literal("review"),
	surface: Schema.Literal("doc"),
	inputRef: InputRef,
	label: ReviewDocLabel,
});

const ReviewSkillEntry = Schema.Struct({
	stage: Schema.Literal("review"),
	surface: Schema.Literal("skill"),
	inputRef: InputRef,
	label: ReviewSkillLabel,
});

/**
 * The rows the v1 `review-code` / `review-doc` gates recorded, under the label shapes their
 * surfaces now carry. They keep their own stage keys for the same reason `write-code` does — a
 * recorded stage key is provenance, and they carry no `surface`, which is a live-schema field. The
 * live key `review` is what a manifest groups all four under.
 */
const RecordedReviewCodeEntry = Schema.Struct({
	stage: Schema.Literal("review-code"),
	inputRef: InputRef,
	label: ReviewCodeLabel,
});

const RecordedReviewDocEntry = Schema.Struct({
	stage: Schema.Literal("review-doc"),
	inputRef: InputRef,
	label: ReviewDocLabel,
});

/**
 * Everything a manifest's `review` group admits: all three live surfaces plus the two recorded
 * keys. There is no recorded `review-skill` key, because the v1 gate recorded no rows under one —
 * a provenance key is minted by history, never in advance (#4977).
 */
const ReviewGroupEntry = Schema.Union([
	ReviewCodeEntry,
	ReviewDocEntry,
	ReviewSkillEntry,
	RecordedReviewCodeEntry,
	RecordedReviewDocEntry,
]);

/** ship-it's oracle: whether the PR merged and the head SHA it merged. */
const ShipItEntry = Schema.Struct({
	stage: Schema.Literal("ship-it"),
	inputRef: InputRef,
	label: Schema.Struct({
		merged: Schema.Boolean,
		mergeSha: Schema.String,
	}),
});

/**
 * One labeled corpus input — a discriminated union on `stage`, and on `(stage, surface)` for the
 * `review` stage. Decoding selects the member by those literals, so a label shape that doesn't
 * belong to that stage — or, under `review`, to that surface — is rejected.
 */
export const CorpusEntry = Schema.Union([
	TriageEntry,
	BuildEntry,
	RecordedWriteCodeEntry,
	ReviewCodeEntry,
	ReviewDocEntry,
	ReviewSkillEntry,
	RecordedReviewCodeEntry,
	RecordedReviewDocEntry,
	ShipItEntry,
]);

export type CorpusEntry = typeof CorpusEntry.Type;

/**
 * The frozen, version-controlled ground truth: entries grouped under LIVE stage keys. Each
 * group's value schema is that stage's entry alone, so a mismatched entry cannot be filed
 * under the wrong stage — the second half of the unrepresentable-invalid guarantee. `build` and
 * `review` additionally admit the recorded v1 rows, which share their label shapes and keep their
 * own provenance keys.
 */
export const CorpusManifest = Schema.Struct({
	version: Schema.Int,
	stages: Schema.Struct({
		triage: Schema.Array(TriageEntry),
		build: Schema.Array(Schema.Union([BuildEntry, RecordedWriteCodeEntry])),
		review: Schema.Array(ReviewGroupEntry),
		"ship-it": Schema.Array(ShipItEntry),
	}),
});

export type CorpusManifest = typeof CorpusManifest.Type;

/** A typed manifest decode failure — malformed JSON, or a shape that doesn't match the schema. */
export class ManifestDecodeError extends Schema.TaggedErrorClass<ManifestDecodeError>()(
	"ManifestDecodeError",
	{
		reason: Schema.Literals(["malformed-json", "schema-mismatch"]),
		message: Schema.String,
	},
) {}

const decodeUnknownManifest = Schema.decodeUnknownResult(CorpusManifest);
const encodeManifest_ = Schema.encodeSync(CorpusManifest);

/**
 * Decode a manifest from its on-disk text. Total — a non-JSON body or a schema mismatch
 * both return a typed `Result` failure, never a throw.
 */
export const decodeManifest = (text: string): Result.Result<CorpusManifest, ManifestDecodeError> =>
	Result.try({
		try: (): unknown => JSON.parse(text),
		catch: (cause) =>
			new ManifestDecodeError({
				reason: "malformed-json",
				message: cause instanceof Error ? cause.message : String(cause),
			}),
	}).pipe(
		Result.flatMap((parsed) =>
			decodeUnknownManifest(parsed).pipe(
				Result.mapError(
					(error) => new ManifestDecodeError({reason: "schema-mismatch", message: error.message}),
				),
			),
		),
	);

/** Serialize a valid manifest to its canonical on-disk text (round-trips with `decodeManifest`). */
export const encodeManifest = (manifest: CorpusManifest): string =>
	`${JSON.stringify(encodeManifest_(manifest), null, "\t")}\n`;
