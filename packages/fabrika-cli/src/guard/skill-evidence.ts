/**
 * `guard skill-evidence-guard check`'s pure half — a change to a skill under the skills root must
 * carry committed benchmark evidence, produced by the trusted in-repo runner, that proves the skill
 * earns its place at the exact content the PR ships (ADR 0403, founder ruling 2026-09-21).
 *
 * The judge consumes facts the verb gathers — git trees, file contents, the GitHub run, the policy —
 * and every decision below is arithmetic over those facts, so each red names the exact offender:
 * the report path, the field, the expected-vs-got pair. Two bindings do the load-bearing work:
 * the report's `skill.treeSha` must equal the PR's skill tree (stale evidence refuses), and the
 * trusted run's head commit must carry that same tree (the runner measured what the report attests).
 *
 * The typo exemption is content-based on purpose — its inputs are the diff's own words, so it
 * answers identically on a `pull_request` and a `merge_group` re-run, and its numbers ride the
 * summary either way so the exemption is auditable, never silent.
 */

import {parseJsonOrReason} from "../io/json.ts";
import {type Annotation, atFile} from "./annotate.ts";
import {
	annotationsOrNone,
	clean,
	type GuardVerdict,
	skipped,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

const VERB = "guard skill-evidence-guard check";

/**
 * The zero-scope red, shared by the judge and the verb so a zero-file invocation never depends on
 * the policy being readable to refuse (ADR 0092).
 */
export const ZERO_FILES_REPORT = `${VERB}: handed ZERO files — the scan covered nothing, so it proves nothing, fail-closed like every guard here. The caller resolves the changed-file list; an empty one is a broken caller, never a clean diff.`;

// ---------------------------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------------------------

/** The four numbers a report's arms are judged against. */
export interface Thresholds {
	readonly minRepetitions: number;
	readonly successDelta: number;
	readonly newCriticalErrors: number;
	readonly maxCostRatio: number;
}

/** The narrow typo lane: cheap, auditable, and the only route around a benchmark run. */
export interface TypoExemptionPolicy {
	/** When true, any non-`.md` changed file in the skill disqualifies the exemption. */
	readonly mdOnly: boolean;
	readonly maxChangedWords: number;
	readonly maxWordEditDistance: number;
}

export interface SkillEvidencePolicy {
	/** The workflow file the report's run must have come from (its `path` on the API). */
	readonly producerWorkflow: string;
	readonly skillsRoot: string;
	readonly reportRoot: string;
	readonly thresholds: {
		readonly default: Thresholds;
		/**
		 * Per-skill overrides; a named key replaces that key of `default` for that skill only. A key
		 * the gate does not know is KEPT here and named by the judge as a violation for that skill —
		 * refusing it at parse time would seat a typo in the policy on UNKNOWN for every skill, not a
		 * red for the one skill the override names.
		 */
		readonly perSkill: Readonly<Record<string, ThresholdOverride>>;
	};
	readonly typoExemption: TypoExemptionPolicy;
}

/** A per-skill threshold override: known keys carry finite numbers, unknown keys ride for the judge. */
export type ThresholdOverride = Readonly<Partial<Thresholds>> & {
	readonly [key: string]: unknown;
};

const THRESHOLD_KEYS = [
	"minRepetitions",
	"successDelta",
	"newCriticalErrors",
	"maxCostRatio",
] as const;

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";
const nonNegInt = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 0;
const posInt = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value > 0;
const finiteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);
const isObj = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const unknownKeys = (
	value: Record<string, unknown>,
	known: ReadonlyArray<string>,
): ReadonlyArray<string> =>
	Object.keys(value)
		.filter((key) => !known.includes(key))
		.sort();

const readThresholds = (at: string, value: unknown, errors: Array<string>): Thresholds | null => {
	if (!isObj(value)) {
		errors.push(`${at} must be an object`);
		return null;
	}
	const unknown = unknownKeys(value, THRESHOLD_KEYS);
	if (unknown.length > 0) {
		errors.push(
			`${at} carries unknown key(s) ${unknown.join(", ")} — the gate knows ${THRESHOLD_KEYS.join(", ")}`,
		);
		return null;
	}
	const out: Record<string, number> = {};
	for (const key of THRESHOLD_KEYS) {
		const raw = value[key];
		if (!finiteNumber(raw)) {
			errors.push(`${at}.${key} must be a number (got ${JSON.stringify(raw) ?? "missing"})`);
			return null;
		}
		out[key] = raw;
	}
	return {
		minRepetitions: out.minRepetitions as number,
		successDelta: out.successDelta as number,
		newCriticalErrors: out.newCriticalErrors as number,
		maxCostRatio: out.maxCostRatio as number,
	};
};

export type PolicyParse =
	| {readonly _tag: "Ok"; readonly policy: SkillEvidencePolicy}
	| {readonly _tag: "Err"; readonly errors: ReadonlyArray<string>};

/**
 * Parse and positively validate `benchmarks/skill-evidence/policy.json`. Unknown shape refuses
 * rather than silently defaulting: a policy the gate cannot fully read is a broken gate, and the
 * caller seats that on UNKNOWN, never on defaults it invented.
 */
export const parsePolicy = (text: string): PolicyParse => {
	const parsed = parseJsonOrReason(text);
	if (parsed._tag === "Failed")
		return {_tag: "Err", errors: [`policy is not valid JSON: ${parsed.reason}`]};
	const value = parsed.value;
	if (!isObj(value)) return {_tag: "Err", errors: ["policy must be a JSON object"]};
	const errors: Array<string> = [];
	const unknown = unknownKeys(value, [
		"producerWorkflow",
		"skillsRoot",
		"reportRoot",
		"thresholds",
		"typoExemption",
	]);
	if (unknown.length > 0) {
		return {_tag: "Err", errors: [`policy carries unknown key(s) ${unknown.join(", ")}`]};
	}
	if (!nonEmpty(value.producerWorkflow))
		errors.push("policy.producerWorkflow must be a non-empty string");
	if (!nonEmpty(value.skillsRoot)) errors.push("policy.skillsRoot must be a non-empty string");
	if (!nonEmpty(value.reportRoot)) errors.push("policy.reportRoot must be a non-empty string");
	let defaults: Thresholds | null = null;
	let perSkill: Record<string, ThresholdOverride> = {};
	const thresholds = isObj(value.thresholds) ? value.thresholds : null;
	if (thresholds === null) {
		errors.push("policy.thresholds must be an object");
	} else {
		const tUnknown = unknownKeys(thresholds, ["default", "perSkill"]);
		if (tUnknown.length > 0)
			errors.push(`policy.thresholds carries unknown key(s) ${tUnknown.join(", ")}`);
		defaults = readThresholds("policy.thresholds.default", thresholds.default, errors);
		if (!isObj(thresholds.perSkill)) {
			errors.push("policy.thresholds.perSkill must be an object");
		} else {
			perSkill = {};
			for (const [name, override] of Object.entries(thresholds.perSkill)) {
				if (!isObj(override)) {
					errors.push(`policy.thresholds.perSkill.${name} must be an object`);
					continue;
				}
				// Known keys must be numbers (the gate applies them); unknown keys ride through so the
				// judge, not the parse, names them as a violation for the skill the override names.
				let knownOk = true;
				for (const key of THRESHOLD_KEYS) {
					const raw = override[key];
					if (raw === undefined) continue;
					if (!finiteNumber(raw)) {
						errors.push(
							`policy.thresholds.perSkill.${name}.${key} must be a number (got ${JSON.stringify(raw)})`,
						);
						knownOk = false;
					}
				}
				if (knownOk) perSkill[name] = override as ThresholdOverride;
			}
		}
	}
	let typoPolicy: TypoExemptionPolicy | null = null;
	const typo = isObj(value.typoExemption) ? value.typoExemption : null;
	if (typo === null) {
		errors.push("policy.typoExemption must be an object");
	} else {
		const tUnknown = unknownKeys(typo, ["mdOnly", "maxChangedWords", "maxWordEditDistance"]);
		if (tUnknown.length > 0)
			errors.push(`policy.typoExemption carries unknown key(s) ${tUnknown.join(", ")}`);
		if (typeof typo.mdOnly !== "boolean")
			errors.push("policy.typoExemption.mdOnly must be a boolean");
		if (!posInt(typo.maxChangedWords)) {
			errors.push("policy.typoExemption.maxChangedWords must be a positive integer");
		}
		if (!posInt(typo.maxWordEditDistance)) {
			errors.push("policy.typoExemption.maxWordEditDistance must be a positive integer");
		}
		if (
			typeof typo.mdOnly === "boolean" &&
			posInt(typo.maxChangedWords) &&
			posInt(typo.maxWordEditDistance)
		) {
			typoPolicy = {
				mdOnly: typo.mdOnly,
				maxChangedWords: typo.maxChangedWords,
				maxWordEditDistance: typo.maxWordEditDistance,
			};
		}
	}
	if (errors.length > 0 || defaults === null || typoPolicy === null) {
		return {_tag: "Err", errors: errors.length > 0 ? errors : ["policy did not fully parse"]};
	}
	return {
		_tag: "Ok",
		policy: {
			producerWorkflow: value.producerWorkflow as string,
			skillsRoot: value.skillsRoot as string,
			reportRoot: value.reportRoot as string,
			thresholds: {default: defaults, perSkill},
			typoExemption: typoPolicy,
		},
	};
};

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

export type BaselineKind = "without-skill" | "previous-version";

/** One measured arm of the comparison. Tokens are recorded, never gated — cost is the gated ratio. */
export interface Arm {
	readonly scenarios: number;
	readonly success: number;
	readonly criticalErrors: number;
	readonly tokens: number;
	readonly costUsd: number;
}

export interface SkillEvidenceReport {
	readonly schemaVersion: number;
	readonly skill: {readonly name: string; readonly path: string; readonly treeSha: string};
	readonly baseline: {readonly kind: BaselineKind; readonly treeSha?: string | undefined};
	readonly model: string;
	readonly tools: string;
	readonly scenarioSet: string;
	readonly repetitions: number;
	readonly results: {readonly baseline: Arm; readonly treatment: Arm};
	readonly thresholds: Thresholds;
	readonly provenance: {
		readonly workflow: string;
		readonly runId: number;
		readonly runUrl: string;
		readonly headSha: string;
	};
}

/** The report file's contents as the verb read them: parsed JSON, or why it could not be parsed. */
export type ReportOutcome =
	| {readonly _tag: "ReadError"; readonly reason: string}
	| {readonly _tag: "Json"; readonly value: unknown};

export const parseReport = (text: string): ReportOutcome => {
	const parsed = parseJsonOrReason(text);
	return parsed._tag === "Parsed"
		? {_tag: "Json", value: parsed.value}
		: {_tag: "ReadError", reason: `not valid JSON: ${parsed.reason}`};
};

export type ReportValidation =
	| {readonly _tag: "Ok"; readonly report: SkillEvidenceReport}
	| {readonly _tag: "Err"; readonly errors: ReadonlyArray<string>};

const REPORT_KEYS = [
	"schemaVersion",
	"skill",
	"baseline",
	"model",
	"tools",
	"scenarioSet",
	"repetitions",
	"results",
	"thresholds",
	"provenance",
] as const;

const readArm = (at: string, value: unknown, errors: Array<string>): Arm | null => {
	if (!isObj(value)) {
		errors.push(`${at} must be an object`);
		return null;
	}
	const unknown = unknownKeys(value, [
		"scenarios",
		"success",
		"criticalErrors",
		"tokens",
		"costUsd",
	]);
	if (unknown.length > 0) {
		errors.push(`${at} carries unknown key(s) ${unknown.join(", ")}`);
		return null;
	}
	const ints: Record<string, number> = {};
	for (const key of ["scenarios", "success", "criticalErrors"] as const) {
		const raw = value[key];
		if (!nonNegInt(raw)) {
			errors.push(
				`${at}.${key} must be a non-negative integer (got ${JSON.stringify(raw) ?? "missing"})`,
			);
			return null;
		}
		ints[key] = raw;
	}
	const nums: Record<string, number> = {};
	for (const key of ["tokens", "costUsd"] as const) {
		const raw = value[key];
		if (!finiteNumber(raw)) {
			errors.push(`${at}.${key} must be a number (got ${JSON.stringify(raw) ?? "missing"})`);
			return null;
		}
		nums[key] = raw;
	}
	return {
		scenarios: ints.scenarios as number,
		success: ints.success as number,
		criticalErrors: ints.criticalErrors as number,
		tokens: nums.tokens as number,
		costUsd: nums.costUsd as number,
	};
};

/**
 * Positively validate a parsed report against schemaVersion 1. Every deviation is quoted by field
 * path; nothing defaults silently — a report the schema does not fully recognize reds rather than
 * passing on the fields that happened to parse.
 */
export const validateReport = (value: unknown): ReportValidation => {
	const errors: Array<string> = [];
	if (!isObj(value)) return {_tag: "Err", errors: ["the report must be a JSON object"]};
	const unknown = unknownKeys(value, REPORT_KEYS);
	if (unknown.length > 0) {
		return {
			_tag: "Err",
			errors: [
				`unknown field(s) ${unknown.join(", ")} — schemaVersion 1 admits ${REPORT_KEYS.join(", ")}`,
			],
		};
	}
	if (value.schemaVersion !== 1) {
		errors.push(
			`schemaVersion must be 1 (got ${JSON.stringify(value.schemaVersion) ?? "missing"})`,
		);
	}
	if (!isObj(value.skill)) {
		errors.push("skill must be an object");
	} else {
		const sUnknown = unknownKeys(value.skill, ["name", "path", "treeSha"]);
		if (sUnknown.length > 0) errors.push(`skill carries unknown key(s) ${sUnknown.join(", ")}`);
		if (!nonEmpty(value.skill.name)) errors.push("skill.name must be a non-empty string");
		if (!nonEmpty(value.skill.path)) errors.push("skill.path must be a non-empty string");
		if (!nonEmpty(value.skill.treeSha)) errors.push("skill.treeSha must be a non-empty string");
	}
	if (!isObj(value.baseline)) {
		errors.push("baseline must be an object");
	} else {
		const bUnknown = unknownKeys(value.baseline, ["kind", "treeSha"]);
		if (bUnknown.length > 0) errors.push(`baseline carries unknown key(s) ${bUnknown.join(", ")}`);
		const kind = value.baseline.kind;
		if (kind !== "without-skill" && kind !== "previous-version") {
			errors.push(
				`baseline.kind must be "without-skill" or "previous-version" (got ${JSON.stringify(kind) ?? "missing"})`,
			);
		}
		if (value.baseline.treeSha !== undefined && !nonEmpty(value.baseline.treeSha)) {
			errors.push("baseline.treeSha, when present, must be a non-empty string");
		}
	}
	for (const key of ["model", "tools", "scenarioSet"] as const) {
		if (!nonEmpty(value[key])) errors.push(`${key} must be a non-empty string`);
	}
	if (!posInt(value.repetitions)) {
		errors.push(
			`repetitions must be a positive integer (got ${JSON.stringify(value.repetitions) ?? "missing"})`,
		);
	}
	let baselineArm: Arm | null = null;
	let treatmentArm: Arm | null = null;
	if (!isObj(value.results)) {
		errors.push("results must be an object");
	} else {
		const rUnknown = unknownKeys(value.results, ["baseline", "treatment"]);
		if (rUnknown.length > 0) errors.push(`results carries unknown key(s) ${rUnknown.join(", ")}`);
		baselineArm = readArm("results.baseline", value.results.baseline, errors);
		treatmentArm = readArm("results.treatment", value.results.treatment, errors);
	}
	const thresholds = readThresholds("thresholds", value.thresholds, errors);
	if (!isObj(value.provenance)) {
		errors.push("provenance must be an object");
	} else {
		const pUnknown = unknownKeys(value.provenance, ["workflow", "runId", "runUrl", "headSha"]);
		if (pUnknown.length > 0)
			errors.push(`provenance carries unknown key(s) ${pUnknown.join(", ")}`);
		if (!nonEmpty(value.provenance.workflow)) {
			errors.push(
				`provenance.workflow must be a non-empty string (got ${JSON.stringify(value.provenance.workflow) ?? "missing"})`,
			);
		}
		if (!posInt(value.provenance.runId)) {
			errors.push(
				`provenance.runId must be a positive integer (got ${JSON.stringify(value.provenance.runId) ?? "missing"})`,
			);
		}
		if (!nonEmpty(value.provenance.runUrl)) {
			errors.push(
				`provenance.runUrl must be a non-empty string (got ${JSON.stringify(value.provenance.runUrl) ?? "missing"})`,
			);
		}
		if (!nonEmpty(value.provenance.headSha)) {
			errors.push("provenance.headSha must be a non-empty string");
		}
	}
	if (
		errors.length > 0 ||
		baselineArm === null ||
		treatmentArm === null ||
		thresholds === null ||
		!isObj(value.skill) ||
		!isObj(value.baseline) ||
		!isObj(value.provenance)
	) {
		return {_tag: "Err", errors: errors.length > 0 ? errors : ["the report did not fully parse"]};
	}
	return {
		_tag: "Ok",
		report: {
			schemaVersion: 1,
			skill: value.skill as SkillEvidenceReport["skill"],
			baseline: value.baseline as SkillEvidenceReport["baseline"],
			model: value.model as string,
			tools: value.tools as string,
			scenarioSet: value.scenarioSet as string,
			repetitions: value.repetitions as number,
			results: {baseline: baselineArm, treatment: treatmentArm},
			thresholds,
			provenance: value.provenance as SkillEvidenceReport["provenance"],
		},
	};
};

// ---------------------------------------------------------------------------------------------
// The typo lane's word diff
// ---------------------------------------------------------------------------------------------

/** One changed word pair — `old` or `new` is "" for a pure insertion or deletion. */
export interface WordPair {
	readonly old: string;
	readonly new: string;
}

/** The word-level diff facts of one skill's changed files, computed by the verb and judged here. */
export interface TypoFacts {
	/** Changed files that do not end `.md` — any entry disqualifies the exemption when mdOnly. */
	readonly nonMdFiles: ReadonlyArray<string>;
	/** How many changed `.md` files the diff facts cover. */
	readonly mdFiles: number;
	/** Words removed plus words added across those files — conservative, never under-counted. */
	readonly changedWords: number;
	/** Every changed word pair, positionally paired inside each changed region. */
	readonly pairs: ReadonlyArray<WordPair>;
}

export interface WordDiff {
	readonly changedWords: number;
	readonly pairs: ReadonlyArray<WordPair>;
}

/**
 * Above this many words on either side the LCS diff is skipped and the whole file counts as
 * changed: a diff this large can never sit under the exemption's word cap, and reporting it as
 * "certainly over" keeps the arithmetic conservative without paying the quadratic table.
 */
export const WORD_DIFF_CAP = 2000;

const wordsOf = (text: string): ReadonlyArray<string> => text.split(/\s+/).filter((w) => w !== "");

/**
 * The word-level diff of two texts: an LCS walk that emits common words silently and each changed
 * region as positionally paired `(old, new)` words. A region with unequal sides pairs the tail
 * against `""`, so a pure insertion or deletion is a pair whose distance is the word's own length —
 * which is what keeps "whole file added" out of the typo lane unless it is genuinely tiny.
 */
export const diffWords = (oldText: string, newText: string): WordDiff => {
	const oldWords = wordsOf(oldText);
	const newWords = wordsOf(newText);
	if (oldWords.length > WORD_DIFF_CAP || newWords.length > WORD_DIFF_CAP) {
		return {changedWords: oldWords.length + newWords.length, pairs: []};
	}
	const m = oldWords.length;
	const n = newWords.length;
	// dp[i * (n + 1) + j] = LCS length of oldWords[i..] and newWords[j..]; row m and column n are 0.
	const dp = new Uint16Array((m + 1) * (n + 1));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			dp[i * (n + 1) + j] =
				(oldWords[i] ?? "") === (newWords[j] ?? "")
					? (dp[(i + 1) * (n + 1) + (j + 1)] ?? 0) + 1
					: Math.max(dp[(i + 1) * (n + 1) + j] ?? 0, dp[i * (n + 1) + (j + 1)] ?? 0);
		}
	}
	const at = (i: number, j: number): number => dp[i * (n + 1) + j] ?? 0;
	const pairs: Array<WordPair> = [];
	let changedWords = 0;
	let regionOld: Array<string> = [];
	let regionNew: Array<string> = [];
	const flush = (): void => {
		if (regionOld.length === 0 && regionNew.length === 0) return;
		changedWords += regionOld.length + regionNew.length;
		const len = Math.max(regionOld.length, regionNew.length);
		for (let k = 0; k < len; k++) {
			pairs.push({old: regionOld[k] ?? "", new: regionNew[k] ?? ""});
		}
		regionOld = [];
		regionNew = [];
	};
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if ((oldWords[i] ?? "") === (newWords[j] ?? "")) {
			flush();
			i++;
			j++;
			continue;
		}
		if (at(i + 1, j) >= at(i, j + 1)) {
			regionOld.push(oldWords[i] ?? "");
			i++;
		} else {
			regionNew.push(newWords[j] ?? "");
			j++;
		}
	}
	regionOld.push(...oldWords.slice(i));
	regionNew.push(...newWords.slice(j));
	flush();
	return {changedWords, pairs};
};

/** Levenshtein distance over characters — the per-pair cap of the typo lane. */
export const editDistance = (a: string, b: string): number => {
	if (a === b) return 0;
	if (a === "") return b.length;
	if (b === "") return a.length;
	let prev = Array.from({length: b.length + 1}, (_, k) => k);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			row[j] = Math.min(
				(prev[j] ?? 0) + 1,
				(row[j - 1] ?? 0) + 1,
				(prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		prev = row;
	}
	return prev[b.length] ?? 0;
};

export interface TypoVerdict {
	readonly exempt: boolean;
	/** The numbers the summary names, so the exemption is auditable whichever way it goes. */
	readonly note: string;
}

/**
 * Whether a skill's whole change is the typo lane: every changed file `.md`, the total changed
 * words under the cap, and every replaced pair within the edit-distance cap. Everything else —
 * scripts, scorers, assets, a frontmatter rewrite — is a behavior change and never qualifies.
 */
export const typoVerdict = (typo: TypoFacts, policy: TypoExemptionPolicy): TypoVerdict => {
	const maxDistance = typo.pairs.reduce(
		(acc, pair) => Math.max(acc, editDistance(pair.old, pair.new)),
		0,
	);
	const mdOnlyOk = !policy.mdOnly || typo.nonMdFiles.length === 0;
	const wordsOk = typo.changedWords <= policy.maxChangedWords;
	const distanceOk = maxDistance <= policy.maxWordEditDistance;
	const note =
		`${typo.changedWords} changed words across ${typo.mdFiles} .md file(s), max pair distance ${maxDistance}` +
		(typo.nonMdFiles.length > 0 ? `, ${typo.nonMdFiles.length} non-.md file(s)` : "");
	return {exempt: mdOnlyOk && wordsOk && distanceOk, note};
};

// ---------------------------------------------------------------------------------------------
// The facts and the judge
// ---------------------------------------------------------------------------------------------

/** The trusted runner's run as the GitHub API answered it, or `null` when the API did not answer. */
export interface RunFacts {
	readonly exists: boolean;
	readonly path?: string | undefined;
	readonly status?: string | undefined;
	/** `null` while the run has not concluded — the platform's own shape, so an unfinished run reaches the judge as a fact. */
	readonly conclusion?: string | null | undefined;
	readonly headSha?: string | undefined;
}

export interface ProvenanceFacts {
	/** Whether the report's benchmark commit resolves in the local object database. */
	readonly reachable: boolean;
	readonly run: RunFacts | null;
	/** Whether a GitHub token was present — without one, provenance is never verified clean. */
	readonly tokenPresent: boolean;
	/** The skill's tree SHA at the benchmark commit; null when unreachable or unresolvable. */
	readonly benchmarkTreeAtHeadSha?: string | null;
}

/** One changed skill, with everything the judge needs about it. */
export interface SkillFacts {
	/** The skill's directory name — the path segment after the skills root. */
	readonly name: string;
	readonly existsAtHead: boolean;
	readonly existsAtBase: boolean;
	readonly headTreeSha: string | null;
	readonly baseTreeSha: string | null;
	readonly changedFiles: ReadonlyArray<string>;
	readonly typo: TypoFacts;
	readonly report: ReportOutcome;
	readonly provenance: ProvenanceFacts;
}

export interface SkillEvidenceFacts {
	readonly files: ReadonlyArray<string>;
	readonly skills: ReadonlyArray<SkillFacts>;
	readonly policy: SkillEvidencePolicy;
}

const normalize = (path: string): string => path.replace(/\\/g, "/");

const underSkillsRoot = (file: string, skillsRoot: string): boolean => {
	const p = normalize(file);
	return p.startsWith(`${skillsRoot}/`);
};

const skillNameOf = (file: string, skillsRoot: string): string | null => {
	const rest = normalize(file).slice(skillsRoot.length + 1);
	const segment = rest.split("/")[0];
	return segment === undefined || segment === "" ? null : segment;
};

const thresholdsEqual = (a: Thresholds, b: Thresholds): boolean =>
	a.minRepetitions === b.minRepetitions &&
	a.successDelta === b.successDelta &&
	a.newCriticalErrors === b.newCriticalErrors &&
	a.maxCostRatio === b.maxCostRatio;

/**
 * Group a change's files by the skill dir each sits under — the one grouping rule, shared by the
 * verb (which gathers per group) and the judge (which counts skill files), so the two can never
 * disagree about what a skill is. Handed paths are normalized to `/` separators on the way in.
 */
export const groupSkillFiles = (
	files: ReadonlyArray<string>,
	skillsRoot: string,
): ReadonlyArray<readonly [string, ReadonlyArray<string>]> => {
	const groups = new Map<string, Array<string>>();
	for (const file of files) {
		if (!underSkillsRoot(file, skillsRoot)) continue;
		const name = skillNameOf(file, skillsRoot);
		if (name === null) continue;
		const bucket = groups.get(name);
		if (bucket === undefined) groups.set(name, [normalize(file)]);
		else bucket.push(normalize(file));
	}
	return [...groups.entries()];
};

const renderThresholds = (t: Thresholds): string =>
	`{minRepetitions: ${t.minRepetitions}, successDelta: ${t.successDelta}, newCriticalErrors: ${t.newCriticalErrors}, maxCostRatio: ${t.maxCostRatio}}`;

type Applied =
	| {readonly _tag: "Applied"; readonly thresholds: Thresholds}
	| {readonly _tag: "UnknownKeys"; readonly keys: ReadonlyArray<string>};

/** `default` merged with the skill's override; an override naming unknown keys is a violation. */
const appliedThresholds = (policy: SkillEvidencePolicy, skillName: string): Applied => {
	const override = policy.thresholds.perSkill[skillName];
	if (override === undefined) return {_tag: "Applied", thresholds: {...policy.thresholds.default}};
	const unknown = Object.keys(override)
		.filter((key) => !(THRESHOLD_KEYS as ReadonlyArray<string>).includes(key))
		.sort();
	if (unknown.length > 0) return {_tag: "UnknownKeys", keys: unknown};
	// Only the four known keys are merged, so an override can never smuggle a fifth into the set the
	// report is required to deep-equal.
	const known = override as Partial<Thresholds>;
	const def = policy.thresholds.default;
	return {
		_tag: "Applied",
		thresholds: {
			minRepetitions:
				typeof known.minRepetitions === "number" ? known.minRepetitions : def.minRepetitions,
			successDelta: typeof known.successDelta === "number" ? known.successDelta : def.successDelta,
			newCriticalErrors:
				typeof known.newCriticalErrors === "number"
					? known.newCriticalErrors
					: def.newCriticalErrors,
			maxCostRatio: typeof known.maxCostRatio === "number" ? known.maxCostRatio : def.maxCostRatio,
		},
	};
};

const costOk = (baseline: Arm, treatment: Arm, maxRatio: number): boolean =>
	baseline.costUsd > 0
		? treatment.costUsd <= baseline.costUsd * maxRatio
		: treatment.costUsd <= baseline.costUsd + maxRatio;

interface SkillJudgement {
	readonly violations: ReadonlyArray<string>;
	readonly unknowns: ReadonlyArray<string>;
}

/** One gated skill's every check; report/provenance checks that need a validated runId stop early. */
const judgeSkill = (skill: SkillFacts, policy: SkillEvidencePolicy): SkillJudgement => {
	const violations: Array<string> = [];
	const unknowns: Array<string> = [];
	const name = skill.name;
	const expectedPath = `${policy.skillsRoot}/${name}`;
	const reportPath = `${policy.reportRoot}/${name}/report.json`;

	if (skill.report._tag === "ReadError") {
		violations.push(
			`${reportPath}: ${skill.report.reason} — expected committed benchmark evidence at this path (ADR 0403).`,
		);
		return {violations, unknowns};
	}
	const validated = validateReport(skill.report.value);
	if (validated._tag === "Err") {
		violations.push(`${reportPath} fails the report schema (schemaVersion 1):`);
		for (const error of validated.errors) violations.push(`  ${error}`);
		return {violations, unknowns};
	}
	const report = validated.report;

	if (report.skill.treeSha !== skill.headTreeSha) {
		violations.push(
			`${name}: stale evidence: report attests skill tree ${report.skill.treeSha}, PR tree has ${skill.headTreeSha ?? "<skill absent at head>"} — re-run the benchmark at the new skill content.`,
		);
	}
	if (report.skill.path !== expectedPath) {
		violations.push(
			`${name}: report.skill.path is "${report.skill.path}", expected "${expectedPath}".`,
		);
	}
	if (report.skill.name !== name) {
		violations.push(`${name}: report.skill.name is "${report.skill.name}", expected "${name}".`);
	}
	if (skill.existsAtBase) {
		if (report.baseline.kind !== "previous-version") {
			violations.push(
				`${name}: baseline.kind is "${report.baseline.kind}", expected "previous-version" — an UPDATED skill's baseline arm is its own previous version.`,
			);
		} else if (report.baseline.treeSha !== skill.baseTreeSha) {
			violations.push(
				`${name}: stale baseline: report attests previous-version tree ${report.baseline.treeSha ?? "<absent>"}, PR base tree has ${skill.baseTreeSha ?? "<absent>"} — re-run the benchmark against the version this PR updates.`,
			);
		}
	} else if (report.baseline.kind !== "without-skill") {
		violations.push(
			`${name}: baseline.kind is "${report.baseline.kind}", expected "without-skill" — a NEW skill's baseline arm runs with the skill absent.`,
		);
	}

	const applied = appliedThresholds(policy, name);
	if (applied._tag === "UnknownKeys") {
		violations.push(
			`${name}: policy names keys the gate does not know: ${applied.keys.join(", ")} in thresholds.perSkill.${name} — the gate knows ${THRESHOLD_KEYS.join(", ")}.`,
		);
	} else if (!thresholdsEqual(report.thresholds, applied.thresholds)) {
		violations.push(
			`${name}: report.thresholds is ${renderThresholds(report.thresholds)}, expected the applied set ${renderThresholds(applied.thresholds)} — evidence is judged against the policy's thresholds, never a set the report brought (no post-hoc threshold shopping).`,
		);
	} else {
		const {results} = report;
		const {baseline, treatment} = results;
		if (report.repetitions < applied.thresholds.minRepetitions) {
			violations.push(
				`${name}: repetitions ${report.repetitions} < minRepetitions ${applied.thresholds.minRepetitions}.`,
			);
		}
		if (treatment.scenarios !== baseline.scenarios) {
			violations.push(
				`${name}: arms ran different scenario sets — treatment ${treatment.scenarios} scenario(s), baseline ${baseline.scenarios}; the comparison is only meaningful over one set.`,
			);
		}
		if (treatment.success - baseline.success < applied.thresholds.successDelta) {
			violations.push(
				`${name}: successDelta ${treatment.success - baseline.success} (treatment ${treatment.success} - baseline ${baseline.success}) < required ${applied.thresholds.successDelta}.`,
			);
		}
		if (treatment.criticalErrors - baseline.criticalErrors > applied.thresholds.newCriticalErrors) {
			violations.push(
				`${name}: newCriticalErrors ${treatment.criticalErrors - baseline.criticalErrors} (treatment ${treatment.criticalErrors} - baseline ${baseline.criticalErrors}) > allowed ${applied.thresholds.newCriticalErrors}.`,
			);
		}
		if (!costOk(baseline, treatment, applied.thresholds.maxCostRatio)) {
			violations.push(
				`${name}: treatment cost $${treatment.costUsd} exceeds the cap over baseline $${baseline.costUsd} (maxCostRatio ${applied.thresholds.maxCostRatio}${baseline.costUsd > 0 ? "" : ", zero-cost baseline so the ratio is an absolute budget"}).`,
			);
		}
	}

	const {provenance} = skill;
	if (!provenance.tokenPresent) {
		unknowns.push(`${name}: cannot verify provenance without GITHUB_TOKEN — never reported clean.`);
	} else if (provenance.run === null) {
		unknowns.push(
			`${name}: the GitHub API could not be read for benchmark run ${report.provenance.runId} — provenance is UNKNOWN, never clean.`,
		);
	} else if (!provenance.run.exists) {
		unknowns.push(
			`${name}: benchmark run ${report.provenance.runId} was not found among the repository's workflow runs — provenance is UNKNOWN, never clean.`,
		);
	} else if (
		provenance.run.path !== policy.producerWorkflow ||
		provenance.run.status !== "completed" ||
		provenance.run.conclusion !== "success" ||
		provenance.run.headSha !== report.provenance.headSha
	) {
		const got =
			`path ${JSON.stringify(provenance.run.path)}, status ${JSON.stringify(provenance.run.status)}, ` +
			`conclusion ${JSON.stringify(provenance.run.conclusion)}, head_sha ${JSON.stringify(provenance.run.headSha)}`;
		const want =
			`path ${JSON.stringify(policy.producerWorkflow)}, status "completed", ` +
			`conclusion "success", head_sha ${JSON.stringify(report.provenance.headSha)}`;
		violations.push(
			`${name}: evidence did not come from the trusted runner — run ${report.provenance.runId} answered ${got}, expected ${want}.`,
		);
	} else if (!provenance.reachable) {
		unknowns.push(
			`${name}: benchmark commit ${report.provenance.headSha} is absent from this checkout — cannot bind content, UNKNOWN.`,
		);
	} else if (provenance.benchmarkTreeAtHeadSha !== report.skill.treeSha) {
		violations.push(
			`${name}: the trusted run measured different skill content than the report attests — skill tree at the run's head is ${provenance.benchmarkTreeAtHeadSha ?? "<unresolvable>"}, report attests ${report.skill.treeSha}.`,
		);
	}

	return {violations, unknowns};
};

/**
 * The gate's whole rule, in order: zero files red; zero skill files skip; removed skills are
 * recorded but not gated; the typo lane exempts with its numbers named; every other present skill
 * must carry a schema-valid, version-bound, threshold-passing report from the trusted runner.
 */
export const judge = (facts: SkillEvidenceFacts): GuardVerdict => {
	if (facts.files.length === 0) return zeroScope(ZERO_FILES_REPORT);
	const {policy} = facts;
	const skillFileCount = facts.files.filter((file) =>
		underSkillsRoot(file, policy.skillsRoot),
	).length;
	if (skillFileCount === 0 || facts.skills.length === 0) {
		return skipped(
			`${VERB}: 0 of ${facts.files.length} changed files under ${policy.skillsRoot} — the gate has no scope in this change.`,
		);
	}

	const removed: Array<string> = [];
	const exempted: Array<string> = [];
	const gated: Array<SkillFacts> = [];
	for (const skill of facts.skills) {
		if (!skill.existsAtHead) {
			removed.push(skill.name);
			continue;
		}
		const typo = typoVerdict(skill.typo, policy.typoExemption);
		if (typo.exempt) {
			exempted.push(`${skill.name} (${typo.note})`);
			continue;
		}
		gated.push(skill);
	}

	if (gated.length === 0) {
		const parts: Array<string> = [];
		if (removed.length > 0)
			parts.push(`${removed.length} skill(s) removed — no evidence required to delete`);
		if (exempted.length > 0) parts.push(`${exempted.length} typo-exempt: ${exempted.join("; ")}`);
		return skipped(
			`${VERB}: 0 of ${facts.skills.length} changed skill(s) gated — ${parts.join("; ")}. No benchmark evidence required in this change.`,
		);
	}

	const violations: Array<string> = [];
	const unknowns: Array<string> = [];
	const annotations: Array<Annotation> = [];
	let offenders = 0;
	for (const skill of gated) {
		const judgement = judgeSkill(skill, policy);
		if (judgement.violations.length > 0) {
			offenders++;
			violations.push(`${skill.name}:`, ...judgement.violations.map((line) => `  ${line}`));
			annotations.push(
				atFile(
					"error",
					`${policy.reportRoot}/${skill.name}/report.json`,
					`\`${skill.name}\` lacks trusted, version-bound benchmark evidence meeting the policy's thresholds — run the producer workflow and commit its report. See ADR 0403.`,
				),
			);
		}
		unknowns.push(...judgement.unknowns);
	}

	if (violations.length > 0) {
		const report =
			`${VERB}: ${offenders} changed skill(s) lack trusted benchmark evidence:\n` +
			`${violations.join("\n")}\n\n` +
			`A behavior-affecting skill change must carry a report produced by ${policy.producerWorkflow} ` +
			"at the PR's skill content and committed under " +
			`${policy.reportRoot}/<skill>/report.json. Typo-only .md edits under ` +
			`${policy.typoExemption.maxChangedWords} changed words are exempt. See ADR 0403.`;
		return violation(
			report,
			annotationsOrNone(() => annotations),
		);
	}
	if (unknowns.length > 0) {
		return unknown(
			`${VERB}: ${unknowns[0] ?? ""}${unknowns.length > 1 ? ` (+${unknowns.length - 1} more)` : ""}`,
		);
	}
	return clean(
		`${VERB}: skill evidence gate: ${gated.length} skill(s) checked — every changed skill carries trusted, version-bound benchmark evidence meeting the policy's thresholds` +
			` (${removed.length} removed, ${exempted.length} typo-exempt)`,
		gated.length,
	);
};
