/**
 * `guard change-detect-guard check` core — ci.yml's `changes` job must read its changed-file set
 * with a pure `git diff`, never the GitHub API.
 *
 * dorny/paths-filter picks its reader off the `token` input: it calls `pulls.listFiles` whenever a
 * token is set, and falls back to `git diff` only when the token is empty (dorny v3.0.2
 * `src/main.ts`, the PR-event branch of `getChangedFiles`: `if (token) return
 * getChangedFilesFromApi(...)`). `action.yml` DEFAULTS `token` to `${{ github.token }}`, so an
 * absent `token:` selects API mode too. That live API read is the job's only flake surface — a
 * transient API-HTML blip (`invalid character '<'`) hard-failed the step and redded `ci-required`
 * on a defect-free docs-only PR (#3244). ci.yml pins `token: ''`; this reds if that regresses.
 *
 * IO-free: a deterministic transform over the ci.yml text. The read lives in
 * `./change-detect-verb.ts`.
 */

import {parse} from "yaml";

/** ci.yml's `changes` job → the `dorny/paths-filter` step whose `token` this asserts. */
export const CI_CHANGES_SOURCE = {
	file: ".github/workflows/ci.yml",
	job: "changes",
} as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** The verdict. A pass carries no evidence, and each refusal carries exactly its reason. */
export type ChangeDetectVerdict =
	| {readonly pass: true}
	/** A job/step/`with:` was missing — the invariant is unverifiable (fail closed, ADR 0092). */
	| {readonly pass: false; readonly reason: "zero-scope"; readonly detail: string}
	/** The dorny step selects the GitHub-API read (non-empty or defaulted token) — the flake path. */
	| {readonly pass: false; readonly reason: "api-mode"; readonly detail: string};

/**
 * Decide over the ci.yml text: find the `changes` job's first `uses: dorny/paths-filter@…` step and
 * assert its `with.token` is present and empty. `token.trim()` mirrors `@actions/core` `getInput`'s
 * trimming — the exact value dorny's `if (token)` branch sees.
 */
export const judge = (ciText: string): ChangeDetectVerdict => {
	let doc: unknown;
	try {
		doc = parse(ciText);
	} catch (cause) {
		return {
			pass: false,
			reason: "zero-scope",
			detail: `could not parse ci.yml YAML (${String(cause)})`,
		};
	}
	if (!isRecord(doc) || !isRecord(doc.jobs)) {
		return {pass: false, reason: "zero-scope", detail: "ci.yml has no top-level 'jobs:' mapping"};
	}
	const job = doc.jobs[CI_CHANGES_SOURCE.job];
	if (!isRecord(job) || !Array.isArray(job.steps)) {
		return {
			pass: false,
			reason: "zero-scope",
			detail: `ci.yml has no '${CI_CHANGES_SOURCE.job}' job with a 'steps:' list`,
		};
	}
	const filterStep = job.steps.find(
		(s) => isRecord(s) && typeof s.uses === "string" && s.uses.startsWith("dorny/paths-filter"),
	);
	if (!isRecord(filterStep) || !isRecord(filterStep.with)) {
		return {
			pass: false,
			reason: "zero-scope",
			detail: `ci.yml '${CI_CHANGES_SOURCE.job}' job has no dorny/paths-filter step with a 'with:' block`,
		};
	}
	if (!("token" in filterStep.with)) {
		return {
			pass: false,
			reason: "api-mode",
			// biome-ignore-start lint/suspicious/noTemplateCurlyInString: the workflow expression IS the default this refusal is about — spelt any other way it names a thing ci.yml has not got.
			detail:
				"the dorny/paths-filter step sets no 'token:' — it defaults to `${{ github.token }}`, which selects the " +
				"GitHub-API (`pulls.listFiles`) change-detection path that flakes on a transient API-HTML blip (#3245). " +
				"Set `token: ''` to force API-free git-mode detection.",
			// biome-ignore-end lint/suspicious/noTemplateCurlyInString: back to the ordinary rule.
		};
	}
	const token = filterStep.with.token;
	if (typeof token !== "string" || token.trim() !== "") {
		return {
			pass: false,
			reason: "api-mode",
			detail:
				`the dorny/paths-filter step's 'token:' is not the empty string (${JSON.stringify(token)}) — a set token ` +
				"selects the GitHub-API (`pulls.listFiles`) change-detection path that flakes on a transient API-HTML blip " +
				"(#3245). Set `token: ''` to force API-free git-mode detection.",
		};
	}
	return {pass: true};
};

const VERB = "guard change-detect-guard check";

/** The human report for a verdict — what was scanned, or what broke and how to fix it. */
export const renderReport = (verdict: ChangeDetectVerdict): string => {
	if (verdict.pass) {
		return (
			`${VERB}: ci.yml changes job's dorny/paths-filter step sets \`token: ''\` — ` +
			"API-free git-mode change detection is in force (the #3245 API-HTML flake path is closed)"
		);
	}
	if (verdict.reason === "zero-scope") {
		return (
			`${VERB}: ${verdict.detail} — fail-closed (ADR 0092). Could not locate the ci.yml ` +
			"changes-job dorny/paths-filter step, so the API-free git-mode invariant is unverifiable. Is the repo " +
			"root correct, or did the changes job's paths-filter shape change?"
		);
	}
	return (
		`${VERB}: ci.yml's changes-job dorny/paths-filter step is in GitHub-API mode — ` +
		`${verdict.detail}\n\n` +
		"That live GitHub-API read (`pulls.listFiles`) is the sole flake surface of the change-detection step: a " +
		"transient GitHub-API-HTML blip (`invalid character '<'`) hard-fails the step and reds the `ci-required` " +
		"aggregate on a defect-free PR (#3244/#3245). Restore `token: ''` on the dorny/paths-filter step so it " +
		"detects changes with a pure `git diff` (no API read) — the `fetch-depth: 0` checkout carries the base commit."
	);
};
