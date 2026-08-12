/**
 * `eval` skill-eval-set core — decoding a `/skill-creator`-authored **eval set** into the
 * harness (issue #4674, epic #4649).
 *
 * The authoring format is not ours. It is the `skill-creator` plugin's, reused verbatim: its
 * `evals/evals.json` case list and its per-case `eval_metadata.json` sidecar, as documented in that
 * plugin's `references/schemas.md` (`## evals.json`) and its `SKILL.md` "Running and evaluating test
 * cases" step 1. This module **decodes** those two files and adds no required field to either — a
 * skill's eval set lands in the repo exactly as its authoring session emitted it (epic #4649: the
 * authoring tool owns eval authoring, this epic owns eval enforcement).
 *
 * Two non-obvious shapes:
 *
 * 1. **A decoded assertion is a discriminated union on `kind`**, so an assertion whose payload does
 *    not match its kind is unrepresentable: only `mechanical` carries the `cue` naming the
 *    observable it checks, and `judgment` carries none. The kind is **derived** here, never read —
 *    the authored format has no kind field and gains none.
 * 2. **A case's execution tier is derived from its assertions**, not authored, which is what lets a
 *    runner route a case without re-reading its prose (#4676/#4677) while the authored format stays
 *    untouched. The derivation is deliberately biased toward `graded`: see `deriveAssertion`.
 *
 * `decodeSkillEvalSet` / `decodeEvalCaseMetadata` are total in the same way `decodeManifest` is —
 * a typed `Result` failure on malformed JSON or a schema mismatch, never a throw.
 */
import {Result} from "effect";
import * as Schema from "effect/Schema";

/**
 * An authored assertion, as the two authoring surfaces write it. `references/schemas.md` documents
 * `expectations` as a "List of verifiable statements" — plain strings — while the grader's
 * `grading.json` carries each one back as `{text, passed, evidence}`. Accepting the object form
 * keyed on `text` costs nothing and matches a session that round-trips graded output back into the
 * set; the string form is the documented one.
 */
const AuthoredAssertion = Schema.Union([Schema.String, Schema.Struct({text: Schema.String})]);

type AuthoredAssertion = typeof AuthoredAssertion.Type;

/**
 * One case of `evals/evals.json`. Only `id` and `prompt` are required: the authoring session writes
 * the prompts first and drafts assertions later (`SKILL.md` step 1 → step 2), so a set captured
 * between those steps carries neither `expectations` nor `assertions` and must still decode.
 *
 * The two assertion keys are the one genuine inconsistency in the upstream format — `schemas.md`
 * names the field `expectations`, `SKILL.md` calls it "the `assertions` field" — so both are read,
 * `expectations` first (it is the one the documented schema and the eval viewer use).
 */
const AuthoredEvalCase = Schema.Struct({
	id: Schema.Int,
	prompt: Schema.String,
	expected_output: Schema.optionalKey(Schema.String),
	files: Schema.optionalKey(Schema.Array(Schema.String)),
	expectations: Schema.optionalKey(Schema.Array(AuthoredAssertion)),
	assertions: Schema.optionalKey(Schema.Array(AuthoredAssertion)),
});

/** The wire shape of `evals/evals.json` — the authored eval set for one skill. */
export const AuthoredEvalsFile = Schema.Struct({
	skill_name: Schema.String,
	evals: Schema.Array(AuthoredEvalCase),
});

/**
 * The wire shape of a per-case `eval_metadata.json` sidecar. `eval_name` is optional because the
 * only upstream consumers read `prompt` and `eval_id` and tolerate everything else being absent
 * (the eval viewer's `generate_review.py`, the benchmark aggregator).
 */
export const AuthoredEvalMetadata = Schema.Struct({
	eval_id: Schema.Int,
	eval_name: Schema.optionalKey(Schema.String),
	prompt: Schema.String,
	assertions: Schema.optionalKey(Schema.Array(AuthoredAssertion)),
});

/** The observable a mechanically-checkable assertion names. */
export const MECHANICAL_CUES = [
	"exit-status",
	"file-artifact",
	"output-content",
	"tool-invocation",
] as const;

export type MechanicalCue = (typeof MECHANICAL_CUES)[number];

/**
 * The cue lexicon: literal phrases, matched case-insensitively against the assertion text, first
 * match in this order wins. It is deliberately small and literal rather than a general parser —
 * every phrase not listed here falls through to `judgment`, which is the safe direction (see
 * `deriveAssertion`).
 */
const CUE_PHRASES: ReadonlyArray<readonly [MechanicalCue, ReadonlyArray<string>]> = [
	[
		"exit-status",
		["exit code", "exit status", "exits 0", "exits zero", "exits non-zero", "exits nonzero"],
	],
	[
		"file-artifact",
		[
			"file exists",
			"a file named",
			"creates a file",
			"created a file",
			"writes a file",
			"wrote a file",
			"directory exists",
		],
	],
	[
		"output-content",
		[
			"output includes",
			"output contains",
			"stdout includes",
			"stdout contains",
			"stderr includes",
			"stderr contains",
		],
	],
	["tool-invocation", ["used script", "uses script", "ran the script", "runs the script"]],
];

/** A decoded assertion — `cue` exists on `mechanical` alone, so a mismatched payload cannot be built. */
export type SkillEvalAssertion =
	| {readonly kind: "mechanical"; readonly text: string; readonly cue: MechanicalCue}
	| {readonly kind: "judgment"; readonly text: string};

/** The two execution tiers a case is routed to (#4677 deterministic, #4678 graded). */
export const EVAL_TIERS = ["deterministic", "graded"] as const;

export type EvalTier = (typeof EVAL_TIERS)[number];

/** One decoded eval case: the authored fields, plus the derived assertions and tier. */
export interface SkillEvalCase {
	readonly id: number;
	readonly name: string | null;
	readonly prompt: string;
	readonly expectedOutput: string | null;
	/**
	 * The authored `files`, or `null` when the case never wrote the key.
	 *
	 * Absent and `[]` are **not** collapsed, because they are different claims: `[]` is the author
	 * saying this case needs no material, while an absent key says nothing at all — and a graded run
	 * cannot be staged from silence (`./run-workspace.ts`, #5434).
	 */
	readonly files: ReadonlyArray<string> | null;
	readonly assertions: ReadonlyArray<SkillEvalAssertion>;
	readonly tier: EvalTier;
}

/** A decoded eval set: the eval cases one skill's authoring session produced. */
export interface SkillEvalSet {
	readonly skillName: string;
	readonly cases: ReadonlyArray<SkillEvalCase>;
}

/** A decoded `eval_metadata.json` sidecar — the per-case copy the authoring session keeps in sync. */
export interface SkillEvalCaseMetadata {
	readonly id: number;
	readonly name: string | null;
	readonly prompt: string;
	readonly assertions: ReadonlyArray<SkillEvalAssertion>;
}

/** A typed eval-set decode failure — malformed JSON, or a shape that doesn't match the schema. */
export class SkillEvalSetDecodeError extends Schema.TaggedErrorClass<SkillEvalSetDecodeError>()(
	"SkillEvalSetDecodeError",
	{
		reason: Schema.Literals(["malformed-json", "schema-mismatch"]),
		message: Schema.String,
	},
) {}

const assertionText = (assertion: AuthoredAssertion): string =>
	typeof assertion === "string" ? assertion : assertion.text;

/**
 * Classify one authored assertion. A phrase from the cue lexicon makes it `mechanical`; everything
 * else is `judgment`.
 *
 * The asymmetry is the point and is not a hedge: a judgment case mis-derived as mechanical would
 * silently skip the grading it needs and report a green it never earned, while a mechanical case
 * mis-derived as judgment merely costs a graded run. So the lexicon only ever *adds* confidence,
 * and the unmatched default is the expensive-but-correct tier (ADR 0092's fail-closed direction,
 * applied to routing).
 */
export const deriveAssertion = (text: string): SkillEvalAssertion => {
	const haystack = text.toLowerCase();
	for (const [cue, phrases] of CUE_PHRASES) {
		if (phrases.some((phrase) => haystack.includes(phrase))) {
			return {kind: "mechanical", text, cue};
		}
	}
	return {kind: "judgment", text};
};

/**
 * Derive a case's execution tier. A case is `deterministic` only when it has assertions and **every
 * one** of them is mechanical — one judgment assertion puts the whole case on the graded path,
 * because the grader has to run for it anyway. A case with no assertions yet is `graded`: there is
 * nothing to check mechanically, so nothing to push down to the CLI tier.
 */
export const deriveTier = (assertions: ReadonlyArray<SkillEvalAssertion>): EvalTier =>
	assertions.length > 0 && assertions.every((a) => a.kind === "mechanical")
		? "deterministic"
		: "graded";

const decodeUnknownEvalsFile = Schema.decodeUnknownResult(AuthoredEvalsFile);
const decodeUnknownEvalMetadata = Schema.decodeUnknownResult(AuthoredEvalMetadata);

const parseJson = (text: string): Result.Result<unknown, SkillEvalSetDecodeError> =>
	Result.try({
		try: (): unknown => JSON.parse(text),
		catch: (cause) =>
			new SkillEvalSetDecodeError({
				reason: "malformed-json",
				message: cause instanceof Error ? cause.message : String(cause),
			}),
	});

const mismatch = (message: string) =>
	new SkillEvalSetDecodeError({reason: "schema-mismatch", message});

/**
 * Decode an eval set from the text of a `/skill-creator` `evals/evals.json`. Total — a non-JSON
 * body or a schema mismatch both return a typed `Result` failure, never a throw.
 */
export const decodeSkillEvalSet = (
	text: string,
): Result.Result<SkillEvalSet, SkillEvalSetDecodeError> =>
	parseJson(text).pipe(
		Result.flatMap((parsed) =>
			decodeUnknownEvalsFile(parsed).pipe(Result.mapError((error) => mismatch(error.message))),
		),
		Result.map((file) => ({
			skillName: file.skill_name,
			cases: file.evals.map((authored): SkillEvalCase => {
				const assertions = (authored.expectations ?? authored.assertions ?? []).map((a) =>
					deriveAssertion(assertionText(a)),
				);
				return {
					id: authored.id,
					name: null,
					prompt: authored.prompt,
					expectedOutput: authored.expected_output ?? null,
					files: authored.files ?? null,
					assertions,
					tier: deriveTier(assertions),
				};
			}),
		})),
	);

/**
 * Decode one `eval_metadata.json` sidecar. Total in the same way `decodeSkillEvalSet` is.
 */
export const decodeEvalCaseMetadata = (
	text: string,
): Result.Result<SkillEvalCaseMetadata, SkillEvalSetDecodeError> =>
	parseJson(text).pipe(
		Result.flatMap((parsed) =>
			decodeUnknownEvalMetadata(parsed).pipe(Result.mapError((error) => mismatch(error.message))),
		),
		Result.map((metadata) => ({
			id: metadata.eval_id,
			name: metadata.eval_name ?? null,
			prompt: metadata.prompt,
			assertions: (metadata.assertions ?? []).map((a) => deriveAssertion(assertionText(a))),
		})),
	);

/**
 * Join sidecars onto a decoded set by case id, re-deriving each touched case's tier.
 *
 * The authoring session writes both files and updates both with the assertions once drafted
 * (`SKILL.md` step 2), so they normally agree. Where they don't, `evals.json` wins: it is the
 * authored set of record, while a sidecar is a per-run copy in a workspace directory. The sidecar
 * therefore only *fills* — a name the set has no field for, and assertions for a case whose set
 * entry has none yet. A sidecar naming an id the set doesn't carry is ignored, not an error: the
 * workspace holds sidecars for iterations the current set may have dropped.
 */
export const withCaseMetadata = (
	set: SkillEvalSet,
	metadata: ReadonlyArray<SkillEvalCaseMetadata>,
): SkillEvalSet => ({
	skillName: set.skillName,
	cases: set.cases.map((evalCase) => {
		const sidecar = metadata.find((m) => m.id === evalCase.id);
		if (sidecar === undefined) return evalCase;
		const assertions = evalCase.assertions.length > 0 ? evalCase.assertions : sidecar.assertions;
		return {
			...evalCase,
			name: evalCase.name ?? sidecar.name,
			assertions,
			tier: deriveTier(assertions),
		};
	}),
});

/** Per-tier case counts over a decoded set — the summary the `cases` verb prints. */
export const tierCounts = (set: SkillEvalSet): Record<EvalTier, number> => {
	const counts: Record<EvalTier, number> = {deterministic: 0, graded: 0};
	for (const evalCase of set.cases) counts[evalCase.tier] += 1;
	return counts;
};
