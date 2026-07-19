/**
 * `change-detect-guard` pure core (#3245) — assert ci.yml's `changes` job
 * `dorny/paths-filter` step runs API-FREE git-mode change detection (`token: ''`).
 *
 * dorny/paths-filter reads the changed-file set two ways on a `pull_request` event: it
 * calls the GitHub REST API (`pulls.listFiles`) WHENEVER a `token` is set, and falls back
 * to a pure `git diff` against `pull_request.base.sha` ONLY when the token is empty (dorny
 * v3.0.2 `src/main.ts`, the PR-event branch of `getChangedFiles`: `if (token) return
 * getChangedFilesFromApi(...)`, else "Github token is not available - changes will be
 * detected using git diff"). dorny's `action.yml` DEFAULTS `token` to `${{ github.token }}`,
 * so an absent `token:` still selects API mode. That live API read is the sole flake surface
 * in the job: a transient GitHub-API-HTML blip served an error page where JSON was expected
 * (`invalid character '<'`), hard-failing the step and reddening the `ci-required` aggregate
 * on a defect-free docs-only PR (#3244). ci.yml pins `token: ''` to force the API-free git
 * path; this guard fails closed if that regresses (an explicit non-empty token, or an absent
 * `token:` falling back to the `github.token` default), which would reopen the flake.
 *
 * IO-free and total: a deterministic transform over the ci.yml text. The filesystem seam
 * (read the file) lives in `gate.ts`; this module never touches disk. Fail-closed on zero
 * scope (ADR 0092): a missing job / paths-filter step / `with:` block — anything that leaves
 * the invariant unverifiable — is a FAILURE, never a vacuous pass.
 */
import {parse} from "yaml";

/** ci.yml's `changes` job → the `dorny/paths-filter` step whose `token` we assert. */
export const CI_CHANGES_SOURCE = {
	file: ".github/workflows/ci.yml",
	job: "changes",
} as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The guard verdict — a discriminated union so an invalid state is unrepresentable: a pass
 * carries no evidence, and each failure shape carries exactly its reason.
 */
export type ChangeDetectVerdict =
	| {readonly pass: true}
	/** A job/step/`with:` was missing — the invariant is unverifiable (fail closed, ADR 0092). */
	| {readonly pass: false; readonly reason: "zero-scope"; readonly detail: string}
	/** The dorny step selects the GitHub-API read (non-empty or defaulted token) — the flake path. */
	| {readonly pass: false; readonly reason: "api-mode"; readonly detail: string};

/**
 * Decide the verdict over the ci.yml text. Parses the workflow, finds the `changes` job's
 * first `uses: dorny/paths-filter@…` step, and asserts its `with.token` is present and
 * empty (git-mode). Any structural gap is `zero-scope`; a missing or non-empty token is
 * `api-mode`. `token.trim()` mirrors `@actions/core` `getInput`'s default trimming — the
 * exact value dorny's `if (token)` branch sees.
 */
export const judge = (ciText: string): ChangeDetectVerdict => {
	let doc: unknown;
	try {
		doc = parse(ciText);
	} catch (cause) {
		return {pass: false, reason: "zero-scope", detail: `could not parse ci.yml YAML (${String(cause)})`};
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
			detail:
				"the dorny/paths-filter step sets no 'token:' — it defaults to `${{ github.token }}`, which selects the " +
				"GitHub-API (`pulls.listFiles`) change-detection path that flakes on a transient API-HTML blip (#3245). " +
				"Set `token: ''` to force API-free git-mode detection.",
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

/** Render the human-readable report (ADR 0092 §1 "emit what you scanned"). */
export const renderReport = (verdict: ChangeDetectVerdict): string => {
	if (verdict.pass) {
		return (
			"change-detect-guard: ci.yml changes job's dorny/paths-filter step sets `token: ''` — " +
			"API-free git-mode change detection is in force (the #3245 API-HTML flake path is closed)"
		);
	}
	if (verdict.reason === "zero-scope") {
		return (
			`change-detect-guard: ${verdict.detail} — fail-closed (ADR 0092). Could not locate the ci.yml ` +
			"changes-job dorny/paths-filter step, so the API-free git-mode invariant is unverifiable. Is the repo " +
			"root correct, or did the changes job's paths-filter shape change?"
		);
	}
	return (
		"change-detect-guard: ci.yml's changes-job dorny/paths-filter step is in GitHub-API mode — " +
		`${verdict.detail}\n\n` +
		"That live GitHub-API read (`pulls.listFiles`) is the sole flake surface of the change-detection step: a " +
		"transient GitHub-API-HTML blip (`invalid character '<'`) hard-fails the step and reds the `ci-required` " +
		"aggregate on a defect-free PR (#3244/#3245). Restore `token: ''` on the dorny/paths-filter step so it " +
		"detects changes with a pure `git diff` (no API read) — the `fetch-depth: 0` checkout carries the base commit."
	);
};
