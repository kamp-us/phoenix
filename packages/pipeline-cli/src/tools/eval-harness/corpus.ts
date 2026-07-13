/**
 * `eval-harness` corpus core — the typed data model + on-disk format for the graded
 * per-stage ground truth (issue #1848, epic #1842).
 *
 * The token-economics apparatus (ADR 0112) grades one frozen input per stage with a
 * binary oracle — enough for a deterministic lever flip, not for a stochastic model
 * swap. This module is the shared core every later slice reads and writes: a labeled
 * *corpus* per stage, the graded generalization of ADR 0112 §1's single frozen input
 * into a version-controlled ground truth. See ADR 0112.
 *
 * The one non-obvious shape: a corpus entry is a **discriminated union keyed on `stage`**,
 * so a label whose shape doesn't match its stage is *unrepresentable* — the write-code
 * label `{fixesRef, ciGreen, reviewVerdict}` cannot sit under `stage: "triage"`, whose
 * only admissible label is `{type, priority, status}` (make-invalid-states-unrepresentable).
 * The manifest doubles the guarantee: it groups entries under per-stage keys whose value
 * schema is that stage's entry alone, so a mismatched entry can't even be filed.
 *
 * `decodeManifest` is total — it returns a typed `Result` failure on malformed JSON or a
 * schema mismatch, never a throw.
 */
import {Result} from "effect";
import * as Schema from "effect/Schema";

/** The five graded pipeline stages a corpus entry can label. */
export const STAGES = ["triage", "write-code", "review-code", "review-doc", "ship-it"] as const;

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

/** write-code's oracle: the issue it fixes, a green CI, and the review verdict its PR earned. */
const WriteCodeEntry = Schema.Struct({
	stage: Schema.Literal("write-code"),
	inputRef: InputRef,
	label: Schema.Struct({
		fixesRef: InputRef,
		ciGreen: Schema.Boolean,
		reviewVerdict: Verdict,
	}),
});

/** review-code's oracle: the verdict plus the acceptance-criteria findings it surfaced. */
const ReviewCodeEntry = Schema.Struct({
	stage: Schema.Literal("review-code"),
	inputRef: InputRef,
	label: Schema.Struct({
		verdict: Verdict,
		acFindings: Schema.Array(Schema.String),
	}),
});

/** review-doc's oracle: the verdict plus the doc findings it surfaced. */
const ReviewDocEntry = Schema.Struct({
	stage: Schema.Literal("review-doc"),
	inputRef: InputRef,
	label: Schema.Struct({
		verdict: Verdict,
		findings: Schema.Array(Schema.String),
	}),
});

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
 * One labeled corpus input — a discriminated union on `stage`. Decoding selects the member
 * by its `stage` literal, so a label shape that doesn't belong to that stage is rejected.
 */
export const CorpusEntry = Schema.Union([
	TriageEntry,
	WriteCodeEntry,
	ReviewCodeEntry,
	ReviewDocEntry,
	ShipItEntry,
]);

export type CorpusEntry = typeof CorpusEntry.Type;

/**
 * The frozen, version-controlled ground truth: entries grouped under per-stage keys. Each
 * group's value schema is that stage's entry alone, so a mismatched entry cannot be filed
 * under the wrong stage — the second half of the unrepresentable-invalid guarantee.
 */
export const CorpusManifest = Schema.Struct({
	version: Schema.Int,
	stages: Schema.Struct({
		triage: Schema.Array(TriageEntry),
		"write-code": Schema.Array(WriteCodeEntry),
		"review-code": Schema.Array(ReviewCodeEntry),
		"review-doc": Schema.Array(ReviewDocEntry),
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
