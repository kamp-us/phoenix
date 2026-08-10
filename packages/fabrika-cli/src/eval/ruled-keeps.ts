/**
 * `eval` ruled-KEEP-corpus core — the committed enumeration of the fabrika eval feedstock
 * (issue #4823, epic #4649).
 *
 * The corpus's membership was ruled in #4642 but never written down, so every consumer re-ran a
 * two-artifact join by hand and the size that was published (74) matched no derivation. This module
 * decodes the enumeration that replaces that join, and re-checks the claims a well-shaped file can
 * still make falsely.
 *
 * Three shapes carry the weight:
 *
 * 1. **A row is a discriminated union on `status`**, so a `pending` row without a written reason is
 *    unrepresentable. #4180 is the one pending row — the ruling retracted its sweep verdict and
 *    never replaced it — and the union is what stops a future editor from resolving it by deleting
 *    a field.
 * 2. **Coverage is derived, never stored.** Whether a case in `provenance.json` already pins an
 *    issue is computed by joining the two files at read time (`withCoverage`). A committed copy of
 *    that flag would be a second source of truth that drifts silently from the ledger — which is
 *    the defect class this whole enumeration exists to remove (#4482).
 * 3. **The derivation travels with the data.** `derivation` records the recipe, the source
 *    artifacts and the arithmetic, so the list is auditable rather than asserted.
 *
 * `decodeRuledKeeps` is total in the same way `decodeIncidentProvenance` is — a typed `Result`
 * failure on malformed JSON or a schema mismatch, never a throw.
 */
import {Result} from "effect";
import * as Schema from "effect/Schema";
import type {IncidentProvenance} from "./incident-provenance.ts";

/**
 * A point-in-time read of an issue's board state. Named `snapshot` and dated because it is the one
 * part of a row that rots: milestone and state move under the file, and a reader who mistakes a
 * stale field for a live one is back to trusting a plausible value.
 */
const Snapshot = Schema.Struct({
	at: Schema.String,
	state: Schema.Literals(["open", "closed"]),
	milestone: Schema.NullOr(Schema.String),
});

const RowFields = {
	issue: Schema.Int,
	title: Schema.String,
	sweepVerdict: Schema.String,
	sweepReason: Schema.String,
	sweepSection: Schema.String,
	borderline: Schema.Boolean,
	snapshot: Snapshot,
};

/** An issue the recipe admits to the corpus. */
const MemberRow = Schema.Struct({status: Schema.Literal("member"), ...RowFields});

/** An issue whose membership the ruling left open. `pendingReason` is required: it quotes what is owed. */
const PendingRow = Schema.Struct({
	status: Schema.Literal("pending"),
	pendingReason: Schema.String,
	...RowFields,
});

const KeepRow = Schema.Union([MemberRow, PendingRow]);

/** How the enumeration was produced — the recipe, the artifacts it read, and the arithmetic. */
const Derivation = Schema.Struct({
	recipe: Schema.String,
	sources: Schema.Array(Schema.String),
	arithmetic: Schema.Array(Schema.String),
});

/** The wire shape of `incident-corpus/ruled-keeps.json`. */
export const RuledKeepsFile = Schema.Struct({
	corpus: Schema.String,
	derivedAt: Schema.String,
	derivation: Derivation,
	rows: Schema.Array(KeepRow),
});

export type KeepRow = typeof KeepRow.Type;
export type RuledKeeps = typeof RuledKeepsFile.Type;

/** The verdict text a member row must carry on the #4634 sweep table. */
export const KEEP_VERDICT = "KEEP-AS-EVAL";

/** A typed enumeration decode failure — malformed JSON, or a shape that doesn't match the schema. */
export class RuledKeepsDecodeError extends Schema.TaggedErrorClass<RuledKeepsDecodeError>()(
	"RuledKeepsDecodeError",
	{
		reason: Schema.Literals(["malformed-json", "schema-mismatch"]),
		message: Schema.String,
	},
) {}

const decodeUnknownRuledKeeps = Schema.decodeUnknownResult(RuledKeepsFile);

const parseJson = (text: string): Result.Result<unknown, RuledKeepsDecodeError> =>
	Result.try({
		try: (): unknown => JSON.parse(text),
		catch: (cause) =>
			new RuledKeepsDecodeError({
				reason: "malformed-json",
				message: cause instanceof Error ? cause.message : String(cause),
			}),
	});

/** Decode the enumeration from the text of `incident-corpus/ruled-keeps.json`. Total. */
export const decodeRuledKeeps = (text: string): Result.Result<RuledKeeps, RuledKeepsDecodeError> =>
	parseJson(text).pipe(
		Result.flatMap((parsed) =>
			decodeUnknownRuledKeeps(parsed).pipe(
				Result.mapError(
					(error) => new RuledKeepsDecodeError({reason: "schema-mismatch", message: error.message}),
				),
			),
		),
	);

/**
 * The enumeration's own integrity rules, as reasons rather than a boolean. An empty array means the
 * list holds; each string names one rule a specific row broke.
 *
 * These are not the schema's job: the schema makes a malformed *shape* unrepresentable, while these
 * are the claims a well-shaped file can still make falsely — a member row that never carried the
 * KEEP-AS-EVAL verdict the recipe requires, a pending row whose reason is blank, an enumeration that
 * records no derivation, or an empty list reporting green over nothing (ADR 0092).
 */
export const ruledKeepsViolations = (keeps: RuledKeeps): ReadonlyArray<string> => {
	const violations: string[] = [];
	if (keeps.rows.length === 0) violations.push("enumeration is empty — zero scope reds (ADR 0092)");
	if (keeps.derivation.recipe.trim() === "") violations.push("derivation records no recipe");
	if (keeps.derivation.sources.length === 0) violations.push("derivation cites no source artifact");
	if (keeps.derivation.arithmetic.length === 0) {
		violations.push("derivation shows no arithmetic");
	}
	const seen = new Set<number>();
	for (const row of keeps.rows) {
		if (seen.has(row.issue)) violations.push(`#${row.issue}: duplicate row`);
		seen.add(row.issue);
		if (row.status === "member" && row.sweepVerdict !== KEEP_VERDICT) {
			violations.push(
				`#${row.issue}: member row carries sweep verdict '${row.sweepVerdict}', not ${KEEP_VERDICT}`,
			);
		}
		if (row.status === "pending" && row.pendingReason.trim() === "") {
			violations.push(`#${row.issue}: pending row records no reason`);
		}
		if (row.sweepReason.trim() === "") violations.push(`#${row.issue}: no sweep reason recorded`);
	}
	return violations;
};

/**
 * The corpus size as the enumeration itself computes it — the one phrase every artifact that
 * publishes this cardinality must carry verbatim.
 *
 * A published figure written as a literal is a second source of truth: the enumeration moves, the
 * prose does not, and the reader gets a plausible number instead of an error (#4482, the class this
 * corpus exists to record). Deriving the phrase from `rows` is what lets `publishedFigureViolations`
 * red on drift rather than on a spelling.
 */
export const publishedFigure = (keeps: RuledKeeps): string => {
	const members = keeps.rows.filter((row) => row.status === "member").length;
	return `${members} members plus ${keeps.rows.length - members} pending`;
};

/**
 * Phrasings that assert a corpus size the enumeration disproves. These are the exact strings the
 * 74 was published as in-tree; the deny-list catches a copy of one, while the *positive* half of
 * the check — the derived figure must be present — is what catches a figure that merely went stale.
 */
export const DISCREDITED_FIGURES: ReadonlyArray<string> = [
	"74-issue KEEP corpus",
	"74 KEEP",
	"ruled at 74",
];

/**
 * Check one artifact that publishes the corpus size against the enumeration. An empty array means
 * the surface agrees with the file; each string names one way it does not.
 */
export const publishedFigureViolations = (
	surface: string,
	text: string,
	figure: string,
): ReadonlyArray<string> => {
	const violations: string[] = [];
	if (!text.includes(figure)) {
		violations.push(`${surface}: does not publish the enumerated figure '${figure}'`);
	}
	for (const stale of DISCREDITED_FIGURES) {
		if (text.includes(stale)) violations.push(`${surface}: asserts the discredited '${stale}'`);
	}
	return violations;
};

/** A row joined with the corpus coverage the provenance ledger reports for it. */
export interface CoveredRow {
	readonly row: KeepRow;
	readonly pinnedBy: ReadonlyArray<number>;
}

/**
 * Join the enumeration against the provenance ledger: for each row, the ids of the committed eval
 * cases that cite it. Derived at read time so the flag cannot drift from the ledger.
 */
export const withCoverage = (
	keeps: RuledKeeps,
	provenance: IncidentProvenance,
): ReadonlyArray<CoveredRow> =>
	keeps.rows.map((row) => ({
		row,
		pinnedBy: provenance.cases
			.filter((entry) => entry.incidents.includes(`#${row.issue}`))
			.map((entry) => entry.id),
	}));

/** The counts the `keeps` verb prints: members, pending rows, borderline, and how many are covered. */
export interface KeepsSummary {
	readonly members: number;
	readonly pending: number;
	readonly borderline: number;
	readonly covered: number;
	readonly uncovered: number;
}

export const summarize = (covered: ReadonlyArray<CoveredRow>): KeepsSummary => {
	const members = covered.filter((c) => c.row.status === "member");
	return {
		members: members.length,
		pending: covered.length - members.length,
		borderline: covered.filter((c) => c.row.borderline).length,
		covered: members.filter((c) => c.pinnedBy.length > 0).length,
		uncovered: members.filter((c) => c.pinnedBy.length === 0).length,
	};
};

const renderRow = ({row, pinnedBy}: CoveredRow): string => {
	const flags = [
		row.status === "pending" ? "PENDING" : null,
		row.borderline ? "borderline" : null,
		pinnedBy.length > 0 ? `pinned by case ${pinnedBy.join(", ")}` : "no case",
	].filter((f): f is string => f !== null);
	const head = `  #${row.issue} [${flags.join(" · ")}] ${row.sweepVerdict} — ${row.sweepReason}`;
	// A pending row that printed like a member would re-create the silence this list removes.
	return row.status === "pending" ? `${head}\n      pending: ${row.pendingReason}` : head;
};

/** The human table — the enumeration as something you read rather than a join you run. */
export const renderKeeps = (keeps: RuledKeeps, covered: ReadonlyArray<CoveredRow>): string => {
	const s = summarize(covered);
	const lines = [
		`${keeps.corpus} — ${s.members} member(s) plus ${s.pending} pending, derived ${keeps.derivedAt}.`,
		`  ${s.borderline} borderline · ${s.covered} pinned by a committed case · ${s.uncovered} uncovered.`,
		"",
		...covered.map(renderRow),
		"",
		"Derivation:",
		`  ${keeps.derivation.recipe}`,
		...keeps.derivation.sources.map((source) => `  source: ${source}`),
		...keeps.derivation.arithmetic.map((line) => `  ${line}`),
	];
	return lines.join("\n");
};

/** The stable machine-readable form — the same rows, plus the derived coverage. */
export const keepsToJson = (keeps: RuledKeeps, covered: ReadonlyArray<CoveredRow>): string =>
	JSON.stringify(
		{
			corpus: keeps.corpus,
			derivedAt: keeps.derivedAt,
			derivation: keeps.derivation,
			summary: summarize(covered),
			rows: covered.map(({row, pinnedBy}) => ({...row, pinnedBy})),
		},
		null,
		2,
	);
