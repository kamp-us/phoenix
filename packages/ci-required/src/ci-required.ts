/**
 * `@kampus/ci-required` core — the pure, IO-free verdict for the `ci-required`
 * aggregator (issue #786, ADR 0092).
 *
 * `ci-required` is the single always-on status context the `main` ruleset
 * requires; the conditional gating jobs (`check`/`unit`/`integration`/`e2e`)
 * each skip on a PR whose changed paths/flags/author they don't cover, so the
 * aggregator must tell a *legitimate not-applicable skip* from a *should-have-run
 * job that was silently skipped* — the latter is the silent-no-op ADR 0092
 * forbids, so it fails closed instead of waving the skip through.
 *
 * The required-ness inputs are single-sourced: the `changes` job emits one
 * `*_required` boolean per gating job, derived from the SAME expression that
 * gates that job's own `if:` (see ci.yml `changes` outputs), so run-ness and
 * required-ness can't drift (#375/#738). This module is the behavioral half that
 * was previously an untested inline bash loop: it takes those booleans + each
 * job's `result` + the `changes` job's own result and returns a deterministic
 * verdict. No IO — `bin.ts` reads the GHA `env:` and prints; this decides.
 */

/**
 * A GitHub Actions job `result` as seen through `needs.<job>.result`. The four
 * documented conclusions, plus `""`/unknown — an empty string is what a `needs`
 * output reads as when the upstream job never produced a conclusion (e.g. its own
 * `needs` was unmet), and is treated as non-success (fail-closed).
 */
export type JobResult = "success" | "skipped" | "failure" | "cancelled" | "" | (string & {});

/** One gating job's required-ness + observed result, the per-job verdict input. */
export interface JobInput {
	readonly name: string;
	/** Did this job's single-sourced `*_required` predicate say it should run? */
	readonly required: boolean;
	/** `needs.<job>.result` — the job's observed conclusion. */
	readonly result: JobResult;
}

export type JobVerdict = "required-pass" | "legit-skip" | "FAIL";

export interface JobReport {
	readonly name: string;
	readonly required: boolean;
	readonly result: JobResult;
	readonly verdict: JobVerdict;
	/** One-line, log-ready reason — the ADR 0092 §1 "emit what you scanned" surface. */
	readonly reason: string;
}

export interface CiRequiredVerdict {
	readonly pass: boolean;
	readonly jobs: ReadonlyArray<JobReport>;
	/**
	 * Set when the `changes` source job itself didn't succeed — its `*_required`
	 * outputs are then empty/untrustworthy, so the whole aggregator fails closed
	 * independently of the per-job rows.
	 */
	readonly changesReport: JobReport | null;
}

/** The verdict for one gating job, given its required-ness and observed result. */
export const judgeJob = (job: JobInput): JobReport => {
	if (job.required) {
		// should_run=true ⇒ result MUST be success; a skip (or any non-success) is
		// the silent-no-op ADR 0092 forbids — fail closed, never mask it.
		if (job.result === "success") {
			return {
				...job,
				verdict: "required-pass",
				reason: `${job.name}: should_run=true result=${job.result} → required-pass`,
			};
		}
		return {
			...job,
			verdict: "FAIL",
			reason: `${job.name}: should_run=true result=${job.result || "<empty>"} → FAIL (a should-have-run gating job did not succeed — silent-no-op, ADR 0092)`,
		};
	}
	// should_run=false ⇒ a skip is the legitimate not-applicable case; success is
	// also fine. Any OTHER non-success (failure/cancelled) is still a real failure.
	if (job.result === "skipped" || job.result === "success") {
		return {
			...job,
			verdict: "legit-skip",
			reason: `${job.name}: should_run=false result=${job.result} → legit-skip`,
		};
	}
	return {
		...job,
		verdict: "FAIL",
		reason: `${job.name}: should_run=false result=${job.result || "<empty>"} → FAIL (not-required job did not pass — unexpected non-success)`,
	};
};

export interface CiRequiredInput {
	/** `needs.changes.result` — the required-ness source job's own conclusion. */
	readonly changesResult: JobResult;
	readonly jobs: ReadonlyArray<JobInput>;
}

/** A `*_required` GHA boolean-string is true only on the literal `"true"`. */
const parseRequired = (value: string | undefined): boolean => value === "true";

/**
 * Map the `ci-required` step's `env:` block (`needs.*.result` + the single-sourced
 * `*_required` booleans) to a `CiRequiredInput`. `check` and `unit` share the
 * `check_required` predicate; `packages-tests` reads its own `packages_required`
 * (#760). Pure over an env record — the bin passes `process.env`, the test passes
 * a literal.
 */
export const inputFromEnv = (e: Record<string, string | undefined>): CiRequiredInput => {
	const result = (key: string): JobResult => e[key] ?? "";
	const jobs: ReadonlyArray<JobInput> = [
		{name: "check", required: parseRequired(e.CHECK_REQUIRED), result: result("CHECK_RESULT")},
		{name: "unit", required: parseRequired(e.CHECK_REQUIRED), result: result("UNIT_RESULT")},
		{
			name: "packages-tests",
			required: parseRequired(e.PACKAGES_REQUIRED),
			result: result("PACKAGES_RESULT"),
		},
		{
			name: "integration",
			required: parseRequired(e.INTEGRATION_REQUIRED),
			result: result("INTEGRATION_RESULT"),
		},
		{name: "e2e", required: parseRequired(e.E2E_REQUIRED), result: result("E2E_RESULT")},
	];
	return {changesResult: result("CHANGES_RESULT"), jobs};
};

/**
 * The whole-aggregator verdict. Fails closed when the `changes` source job didn't
 * succeed (its `*_required` outputs are then untrustworthy) AND/OR when any gating
 * job's per-job verdict is FAIL. Pure: same inputs ⇒ same verdict, no IO.
 */
export const judge = (input: CiRequiredInput): CiRequiredVerdict => {
	const jobs = input.jobs.map(judgeJob);

	let changesReport: JobReport | null = null;
	if (input.changesResult !== "success") {
		changesReport = {
			name: "changes",
			required: true,
			result: input.changesResult,
			verdict: "FAIL",
			reason: `changes: result=${input.changesResult || "<empty>"} → FAIL (the required-ness source job did not succeed; cannot trust skip legitimacy — fail closed, ADR 0092)`,
		};
	}

	const pass = changesReport === null && jobs.every((j) => j.verdict !== "FAIL");
	return {pass, jobs, changesReport};
};
