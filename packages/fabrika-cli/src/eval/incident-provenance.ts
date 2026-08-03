/**
 * `eval` incident-provenance core — the ledger that binds each committed **incident
 * corpus** case to the real artifact it pins (issue #4675, epic #4649).
 *
 * The corpus itself is authored in the reused `/skill-creator` eval format and decoded by
 * `skill-eval-set.ts`; that format has no room for provenance, and gains none here. This is the
 * sidecar: for each case, the incidents it pins, how membership was verified, and the tier it is
 * authored at. Two shapes carry the weight:
 *
 * 1. **The tier is a discriminated union**, so a `graded` case without a written rationale is
 *    unrepresentable. The founder's bar (#4637) pushes cases to the deterministic CLI layer
 *    wherever possible and makes graded the exception that must be justified — encoding that as a
 *    required field is what stops the exception from being taken silently.
 * 2. **A case carries `corrections`, never a rewrite.** Incidents get re-diagnosed: the corpus's
 *    own first entry was recorded as an instrumentation artifact and corrected the same night to a
 *    live code defect (#4675 comment 5153283658). The retraction is worth more than the original
 *    claim, so it is appended beside it rather than replacing it.
 *
 * `decodeIncidentProvenance` is total in the same way `decodeManifest` is — a typed `Result`
 * failure on malformed JSON or a schema mismatch, never a throw.
 */
import {Result} from "effect";
import * as Schema from "effect/Schema";

/** A later re-diagnosis of an incident already in the corpus. */
const Correction = Schema.Struct({
	at: Schema.String,
	source: Schema.String,
	summary: Schema.String,
});

const CaseFields = {
	id: Schema.Int,
	title: Schema.String,
	incidents: Schema.Array(Schema.String),
	verification: Schema.Array(Schema.String),
	corrections: Schema.Array(Correction),
};

/** A case whose assertions are all mechanically checkable — the default tier. */
const DeterministicCase = Schema.Struct({
	tier: Schema.Literal("deterministic"),
	...CaseFields,
});

/** A case that needs the grader. `tierRationale` is required: the exception states its own why. */
const GradedCase = Schema.Struct({
	tier: Schema.Literal("graded"),
	tierRationale: Schema.String,
	...CaseFields,
});

const CaseProvenance = Schema.Union([DeterministicCase, GradedCase]);

/** An incident considered for the corpus and kept out, with the reason it was kept out. */
const DeclinedIncident = Schema.Struct({
	incident: Schema.String,
	reason: Schema.String,
});

/** The wire shape of `incident-corpus/provenance.json`. */
export const IncidentProvenanceFile = Schema.Struct({
	corpus: Schema.String,
	cases: Schema.Array(CaseProvenance),
	declined: Schema.Array(DeclinedIncident),
});

export type CaseProvenance = typeof CaseProvenance.Type;
export type DeclinedIncident = typeof DeclinedIncident.Type;
export type IncidentProvenance = typeof IncidentProvenanceFile.Type;

/** A typed provenance decode failure — malformed JSON, or a shape that doesn't match the schema. */
export class IncidentProvenanceDecodeError extends Schema.TaggedErrorClass<IncidentProvenanceDecodeError>()(
	"IncidentProvenanceDecodeError",
	{
		reason: Schema.Literals(["malformed-json", "schema-mismatch"]),
		message: Schema.String,
	},
) {}

const decodeUnknownProvenance = Schema.decodeUnknownResult(IncidentProvenanceFile);

const parseJson = (text: string): Result.Result<unknown, IncidentProvenanceDecodeError> =>
	Result.try({
		try: (): unknown => JSON.parse(text),
		catch: (cause) =>
			new IncidentProvenanceDecodeError({
				reason: "malformed-json",
				message: cause instanceof Error ? cause.message : String(cause),
			}),
	});

/** Decode the provenance ledger from the text of `incident-corpus/provenance.json`. Total. */
export const decodeIncidentProvenance = (
	text: string,
): Result.Result<IncidentProvenance, IncidentProvenanceDecodeError> =>
	parseJson(text).pipe(
		Result.flatMap((parsed) =>
			decodeUnknownProvenance(parsed).pipe(
				Result.mapError(
					(error) =>
						new IncidentProvenanceDecodeError({
							reason: "schema-mismatch",
							message: error.message,
						}),
				),
			),
		),
	);

/** An incident citation is a bare `#NNNN` — the form every corpus artifact is addressable by. */
export const INCIDENT_CITATION = /^#\d+$/;

/**
 * The ledger's own integrity rules, as reasons rather than a boolean. An empty array means the
 * ledger holds; each string names one rule a specific case broke.
 *
 * These are not the schema's job: the schema makes a malformed *shape* unrepresentable, while these
 * are the claims a well-shaped ledger can still make falsely — a case citing nothing, or citing
 * something that is not an issue number, or admitting an incident with no verification behind it.
 */
export const provenanceViolations = (provenance: IncidentProvenance): ReadonlyArray<string> => {
	const violations: string[] = [];
	const seen = new Set<number>();
	for (const entry of provenance.cases) {
		if (seen.has(entry.id)) violations.push(`case ${entry.id}: duplicate id`);
		seen.add(entry.id);
		if (entry.incidents.length === 0) violations.push(`case ${entry.id}: cites no incident`);
		for (const incident of entry.incidents) {
			if (!INCIDENT_CITATION.test(incident)) {
				violations.push(`case ${entry.id}: incident ${incident} is not a #NNNN citation`);
			}
		}
		if (entry.verification.length === 0) {
			violations.push(`case ${entry.id}: records no verification`);
		}
		if (entry.tier === "graded" && entry.tierRationale.trim() === "") {
			violations.push(`case ${entry.id}: graded with an empty rationale`);
		}
	}
	for (const declined of provenance.declined) {
		if (declined.reason.trim() === "") {
			violations.push(`declined ${declined.incident}: no reason recorded`);
		}
	}
	return violations;
};
