/**
 * `ci-required` core — the pure, IO-free verdict for the `ci-required`
 * aggregator (issue #786, ADR 0092).
 *
 * **No `effect` import, here or in `required-bin.ts`.** The `ci-required` gate job runs on every
 * PR and does no `pnpm install`, so its whole entry path must be plain Node the runtime can type-
 * strip with nothing linked. That is why this pair is not a registered `fabrika ci …` verb: a
 * `Command` would put the Effect CLI on the gate's critical path.
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
 * required-ness can't drift (#375/#738). No IO — `required-bin.ts` reads the GHA `env:`
 * and prints; this decides.
 */

/**
 * A GitHub Actions job `result` as seen through `needs.<job>.result`. The four
 * documented conclusions, plus `""`/unknown — an empty string is what a `needs`
 * output reads as when the upstream job never produced a conclusion (e.g. its own
 * `needs` was unmet), and is treated as non-success (fail-closed).
 */
export type JobResult = "success" | "skipped" | "failure" | "cancelled" | "" | (string & {});

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
	/**
	 * Why the scope itself could not be read: an empty job declaration, or a declared job
	 * whose `env:` block is missing a key. Non-empty forces `pass: false` on its own — an
	 * aggregator that cannot see its jobs must never pass over the ones it happened to find.
	 */
	readonly scopeReasons: ReadonlyArray<string>;
}

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
	/** See {@link CiRequiredVerdict.scopeReasons}. Empty on a fully-declared read. */
	readonly scopeReasons: ReadonlyArray<string>;
}

/** A `*_required` GHA boolean-string is true only on the literal `"true"`. */
const parseRequired = (value: string | undefined): boolean => value === "true";

/**
 * The env var naming the gating jobs this aggregator covers, whitespace- or comma-separated.
 *
 * **The set is declared once, in `ci.yml`, beside the `needs:` list it must match** (#6099). The
 * former shape hand-listed the six jobs here as well, so adding a gating job meant editing two
 * files and forgetting the second one silently dropped a job from the gate. Now the CLI derives
 * every row from this declaration and reds when a declared job's `env:` keys are absent, which is
 * the failure the second list used to hide.
 */
export const JOBS_ENV_KEY = "CI_REQUIRED_JOBS";

/** A job's env prefix: its `needs:` name upper-cased, hyphens to underscores (`packages-tests` → `PACKAGES_TESTS`). */
export const envPrefix = (job: string): string => job.toUpperCase().replace(/-/g, "_");

const declaredJobs = (raw: string | undefined): ReadonlyArray<string> =>
	(raw ?? "")
		.split(/[\s,]+/)
		.map((name) => name.trim())
		.filter((name) => name !== "");

/**
 * Map the `ci-required` step's `env:` block to a `CiRequiredInput`. The job set comes from
 * {@link JOBS_ENV_KEY}; each job contributes `<PREFIX>_RESULT` (`needs.<job>.result`) and
 * `<PREFIX>_REQUIRED` (the single-sourced `changes` output that also gates the job's own `if:`,
 * so run-ness and required-ness cannot drift — #375/#738).
 *
 * A declared job missing either key is a scope failure, not a false: an undeclared required-ness
 * reads exactly like a not-required job, which would wave a should-have-run skip through (ADR
 * 0092). Pure over an env record — the bin passes `process.env`, the test passes a literal.
 */
export const inputFromEnv = (e: Record<string, string | undefined>): CiRequiredInput => {
	const result = (key: string): JobResult => e[key] ?? "";
	const names = declaredJobs(e[JOBS_ENV_KEY]);
	const scopeReasons: Array<string> = [];
	if (names.length === 0) {
		scopeReasons.push(
			`${JOBS_ENV_KEY} names no gating job — the aggregator has nothing to scope to, so it cannot pass (fail closed, ADR 0092). Set it in ci.yml beside the ci-required job's needs: list.`,
		);
	}
	const jobs: Array<JobInput> = [];
	for (const name of names) {
		const prefix = envPrefix(name);
		for (const suffix of ["RESULT", "REQUIRED"]) {
			if (e[`${prefix}_${suffix}`] === undefined) {
				scopeReasons.push(
					`${name}: ${JOBS_ENV_KEY} declares it but the step's env: block sets no ${prefix}_${suffix} — required-ness or run-ness is unreadable, so the row cannot be judged (fail closed, ADR 0092).`,
				);
			}
		}
		jobs.push({
			name,
			required: parseRequired(e[`${prefix}_REQUIRED`]),
			result: result(`${prefix}_RESULT`),
		});
	}
	return {changesResult: result("CHANGES_RESULT"), jobs, scopeReasons};
};

/**
 * The whole-aggregator verdict. Fails closed when the `changes` source job didn't
 * succeed (its `*_required` outputs are then untrustworthy), when the job scope could not be
 * read, AND/OR when any gating job's per-job verdict is FAIL. Pure: same inputs ⇒ same verdict.
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

	const pass =
		changesReport === null &&
		input.scopeReasons.length === 0 &&
		jobs.every((j) => j.verdict !== "FAIL");
	return {pass, jobs, changesReport, scopeReasons: input.scopeReasons};
};
