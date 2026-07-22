/**
 * `path-filter-guard` pure core (issue #2372) — decide whether ci.yml's `changes.e2e` and
 * deploy.yml's `changes.deploy` dorny/paths-filter steps classify a PR's diff the SAME way.
 * IO-free and total: every decision is a deterministic transform over the two workflow-file
 * texts. The filesystem boundary (read the two files) lives in `gate.ts`; this module never
 * touches disk.
 *
 * The load-bearing invariant it mechanizes: deploy's RUN-set must be a SUPERSET of e2e's
 * RUN-set (deploy skips only where e2e also skips). ci.yml's `e2e` job polls deploy.yml's
 * sticky `<!-- preview-deploy -->` comment on a 10-minute deadline, so a PR that trips
 * e2e but skips its deploy makes the poll time out and wedge the required `ci-required`
 * check. Both files pin the invariant with identical lists guarded ONLY by a reciprocal
 * human comment — nothing mechanical stops a future edit to one from drifting the other.
 * Set EQUALITY is the checkable form: equality ⇒ superset, and equality is exactly what the
 * two comments already pin (a general superset check would let deploy grow entries e2e
 * lacks, which the comments forbid).
 *
 * EQUAL GLOBS ARE NOT ENOUGH — the DIFF BASIS must match too (#3722). A glob list only
 * decides which paths matter; dorny's `token` and `base` inputs decide which changed-file
 * set the globs are applied TO. Those inputs drifted while the lists stayed byte-identical:
 * ci.yml pinned `token: ''` (a local two-dot `git diff` from `pull_request.base.sha`) while
 * deploy.yml defaulted `token` to `github.token` (dorny's API read, GitHub's three-dot
 * merge-base diff). Identical globs over different file sets still disagree — and did, on
 * PR #3713, where main's post-branch drift showed up as 22 phantom `e2e:` hits in ci.yml
 * only: `e2e_required` went true, `deploy` correctly skipped, and the e2e poll timed out and
 * permanently redded a defect-free PR. This guard PASSED that PR, because it compared only
 * the lists. It now compares both halves — the globs AND the `(token, base)` basis pair.
 *
 * Fail-closed on zero scope (ADR 0092): a missing file/job/paths-filter step, a missing
 * `e2e:`/`deploy:` key, or an empty list is a FAILURE — a guard that extracted nothing
 * is broken, never a vacuous pass.
 */
import {parse} from "yaml";

/** The source of one filter list — which workflow file, `changes` job, and filter key. */
export interface FilterSource {
	readonly file: string;
	readonly job: string;
	readonly key: string;
}

/** ci.yml's `changes` job → `dorny/paths-filter` step → `e2e:` filter list. */
export const CI_E2E_SOURCE: FilterSource = {
	file: ".github/workflows/ci.yml",
	job: "changes",
	key: "e2e",
};

/** deploy.yml's `changes` job → `dorny/paths-filter` step → `deploy:` filter list. */
export const DEPLOY_SOURCE: FilterSource = {
	file: ".github/workflows/deploy.yml",
	job: "changes",
	key: "deploy",
};

/** The two workflow-file texts the verdict is computed over — read at the IO boundary. */
export interface PathFilterFacts {
	readonly ciText: string;
	readonly deployText: string;
}

/**
 * The changed-file set a dorny step resolves its globs against, read off the two inputs
 * that decide it. `undefined` means the input is absent, which is NOT the same as empty:
 * an absent `token` defaults to `${{ github.token }}` (API mode), an empty one forces git
 * mode — the exact distinction that drifted in #3722.
 */
export interface DiffBasis {
	readonly token: string | undefined;
	readonly base: string | undefined;
}

/** Render a basis for a human report, naming the mode each input selects. */
export const describeBasis = (basis: DiffBasis): string => {
	const token =
		basis.token === undefined
			? "token: <absent> ⇒ defaults to github.token (API/listFiles mode)"
			: basis.token.trim() === ""
				? "token: '' (API-free git-diff mode)"
				: `token: ${basis.token} (API/listFiles mode)`;
	const base =
		basis.base === undefined
			? "base: <absent> ⇒ two-dot diff from pull_request.base.sha"
			: `base: ${basis.base}`;
	return `${token}; ${base}`;
};

/**
 * Extracting one filter step either yields its glob entries plus its diff basis, or the
 * reason it couldn't — every `ok: false` arm is a zero-scope failure (ADR 0092), never
 * treated as an empty pass.
 */
export type FilterExtraction =
	| {readonly ok: true; readonly entries: ReadonlyArray<string>; readonly basis: DiffBasis}
	| {readonly ok: false; readonly detail: string};

/**
 * The guard verdict — a discriminated union so an invalid state is unrepresentable: a
 * pass never carries a drift list, and each failure shape carries exactly its evidence.
 */
export type PathFilterVerdict =
	| {readonly pass: true; readonly count: number}
	/** A file/job/step/key was missing or a list was empty — fail closed (ADR 0092). */
	| {readonly pass: false; readonly reason: "zero-scope"; readonly detail: string}
	/** The two path sets differ — the sync invariant has drifted. */
	| {
			readonly pass: false;
			readonly reason: "drift";
			/** Entries in ci.yml's `e2e` list absent from deploy.yml's `deploy` list. */
			readonly onlyInE2e: ReadonlyArray<string>;
			/** Entries in deploy.yml's `deploy` list absent from ci.yml's `e2e` list. */
			readonly onlyInDeploy: ReadonlyArray<string>;
	  }
	/** Equal globs, but resolved against different changed-file sets (#3722). */
	| {
			readonly pass: false;
			readonly reason: "basis-drift";
			readonly ciBasis: DiffBasis;
			readonly deployBasis: DiffBasis;
	  };

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Normalize a dorny filter value (a YAML list of globs, or a lone scalar) to a trimmed
 * string array. dorny parses the `filters:` block as YAML, so the inline `#` comments are
 * already stripped by the parse — no comment handling is needed here.
 */
const toGlobList = (value: unknown): ReadonlyArray<string> | undefined => {
	if (typeof value === "string") return [value.trim()];
	if (Array.isArray(value)) {
		const out: Array<string> = [];
		for (const entry of value) {
			if (typeof entry !== "string") return undefined;
			out.push(entry.trim());
		}
		return out;
	}
	return undefined;
};

/**
 * Extract the `<job>` dorny/paths-filter step's `<key>` glob list from a workflow YAML.
 * Pure over the text: parses the workflow, finds the first `uses: dorny/paths-filter@…`
 * step under `jobs.<job>.steps`, parses its `with.filters` string as YAML (as dorny
 * does), and reads the `<key>` list. Any structural gap — unparseable YAML, no such job,
 * no paths-filter step, no `filters`, no `<key>`, or an empty list — is `ok: false`.
 */
export const extractFilterList = (workflowText: string, source: FilterSource): FilterExtraction => {
	let doc: unknown;
	try {
		doc = parse(workflowText);
	} catch (cause) {
		return {ok: false, detail: `${source.file}: could not parse workflow YAML (${String(cause)})`};
	}
	if (!isRecord(doc) || !isRecord(doc.jobs)) {
		return {ok: false, detail: `${source.file}: no top-level 'jobs:' mapping`};
	}
	const job = doc.jobs[source.job];
	if (!isRecord(job) || !Array.isArray(job.steps)) {
		return {ok: false, detail: `${source.file}: no '${source.job}' job with a 'steps:' list`};
	}
	const filterStep = job.steps.find(
		(s) => isRecord(s) && typeof s.uses === "string" && s.uses.startsWith("dorny/paths-filter"),
	);
	if (!isRecord(filterStep) || !isRecord(filterStep.with)) {
		return {
			ok: false,
			detail: `${source.file}: '${source.job}' job has no dorny/paths-filter step with a 'with:' block`,
		};
	}
	const filtersText = filterStep.with.filters;
	if (typeof filtersText !== "string") {
		return {ok: false, detail: `${source.file}: the paths-filter step has no string 'filters:'`};
	}
	let filters: unknown;
	try {
		filters = parse(filtersText);
	} catch (cause) {
		return {ok: false, detail: `${source.file}: 'filters:' is not valid YAML (${String(cause)})`};
	}
	if (!isRecord(filters) || !(source.key in filters)) {
		return {ok: false, detail: `${source.file}: 'filters:' has no '${source.key}:' key`};
	}
	const entries = toGlobList(filters[source.key]);
	if (entries === undefined) {
		return {ok: false, detail: `${source.file}: '${source.key}:' is not a list of glob strings`};
	}
	if (entries.length === 0) {
		return {ok: false, detail: `${source.file}: '${source.key}:' is an empty list`};
	}
	// A non-string `token`/`base` (a number, a null) is read as absent: it cannot be the
	// string the other side pins, so the comparison below still catches it as drift.
	const readInput = (name: string): string | undefined => {
		const raw = (filterStep.with as Record<string, unknown>)[name];
		return typeof raw === "string" ? raw : undefined;
	};
	return {ok: true, entries, basis: {token: readInput("token"), base: readInput("base")}};
};

/**
 * Decide the verdict over the two workflow texts. Order: extract each step (fail closed on
 * any zero-scope gap), compare the globs as SETS (order-independent), then compare the diff
 * basis. Set inequality — an entry in one list absent from the other, in either direction —
 * is drift; equal globs read against a different `(token, base)` pair is basis-drift.
 */
export const judge = (facts: PathFilterFacts): PathFilterVerdict => {
	const e2e = extractFilterList(facts.ciText, CI_E2E_SOURCE);
	if (!e2e.ok) return {pass: false, reason: "zero-scope", detail: e2e.detail};
	const deploy = extractFilterList(facts.deployText, DEPLOY_SOURCE);
	if (!deploy.ok) return {pass: false, reason: "zero-scope", detail: deploy.detail};

	const e2eSet = new Set(e2e.entries);
	const deploySet = new Set(deploy.entries);
	const onlyInE2e = [...e2eSet].filter((g) => !deploySet.has(g)).sort();
	const onlyInDeploy = [...deploySet].filter((g) => !e2eSet.has(g)).sort();
	if (onlyInE2e.length > 0 || onlyInDeploy.length > 0) {
		return {pass: false, reason: "drift", onlyInE2e, onlyInDeploy};
	}
	if (e2e.basis.token !== deploy.basis.token || e2e.basis.base !== deploy.basis.base) {
		return {pass: false, reason: "basis-drift", ciBasis: e2e.basis, deployBasis: deploy.basis};
	}
	return {pass: true, count: e2eSet.size};
};

/** Render the human-readable report (ADR 0092 §1 "emit what you scanned"). */
export const renderReport = (verdict: PathFilterVerdict): string => {
	if (verdict.pass) {
		return (
			`path-filter-guard: ci.yml changes.e2e and deploy.yml changes.deploy are identical ` +
			`(${verdict.count} glob entries, same token/base diff basis) — the deploy⊇e2e sync ` +
			`invariant holds`
		);
	}
	if (verdict.reason === "zero-scope") {
		return (
			`path-filter-guard: ${verdict.detail} — fail-closed (ADR 0092). Could not extract both ` +
			"the ci.yml changes.e2e and deploy.yml changes.deploy filter lists, so the sync invariant " +
			"is unverifiable. Is the repo root correct, or did a workflow's paths-filter shape change?"
		);
	}
	if (verdict.reason === "basis-drift") {
		return (
			"path-filter-guard: ci.yml's changes.e2e filter and deploy.yml's changes.deploy filter " +
			"have the SAME globs but resolve them against a DIFFERENT changed-file set:\n" +
			`  ci.yml     ${describeBasis(verdict.ciBasis)}\n` +
			`  deploy.yml ${describeBasis(verdict.deployBasis)}\n\n` +
			"dorny's `token` picks the reader (absent/non-empty ⇒ the API's three-dot merge-base " +
			"diff; empty ⇒ a local git diff) and `base` picks what that diff is taken from. Equal " +
			"globs over different file sets still disagree about the same PR — which is how a PR " +
			"can trip e2e while its deploy skips, leaving e2e to poll 10 minutes for a preview that " +
			"never arrives and permanently red `ci-required` (#3722, PR #3713). Give both steps the " +
			"SAME `token:` and `base:` inputs."
		);
	}
	const lines: Array<string> = [];
	if (verdict.onlyInE2e.length > 0) {
		lines.push(
			`  ONLY in ci.yml changes.e2e (${verdict.onlyInE2e.length}) — missing from deploy.yml changes.deploy:`,
		);
		for (const g of verdict.onlyInE2e) lines.push(`    ${g}`);
	}
	if (verdict.onlyInDeploy.length > 0) {
		lines.push(
			`  ONLY in deploy.yml changes.deploy (${verdict.onlyInDeploy.length}) — missing from ci.yml changes.e2e:`,
		);
		for (const g of verdict.onlyInDeploy) lines.push(`    ${g}`);
	}
	return (
		"path-filter-guard: ci.yml's changes.e2e filter and deploy.yml's changes.deploy filter " +
		`have DRIFTED — the two path sets are not equal:\n${lines.join("\n")}\n\n` +
		"The deploy job's RUN-set must equal e2e's RUN-set (deploy skips only where e2e also skips). " +
		"A PR that trips e2e but skips its deploy makes e2e's 10-min preview-comment poll time out and " +
		"wedge ci-required (#2372). Restore the two lists to the SAME set of globs — edit whichever " +
		"drifted so the `e2e:` block in ci.yml and the `deploy:` block in deploy.yml match."
	);
};
