/**
 * The pure head-CI rollup core of `checks` — IO-free, total, unit-testable.
 *
 * The one decision every consumer that gates on CI state needs and repeatedly gets wrong:
 * given a head SHA's check runs, is that head green, red, or still pending?
 *
 * `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` returns EVERY run recorded for the
 * SHA, including runs a later re-run superseded — its `filter=latest` default dedupes only
 * WITHIN a check suite, and a re-run opens a NEW suite. Verified against the live API on
 * `bb21a70f`: 123 runs over 41 distinct context names, with `ci-required` present three
 * times — latest `success`, two earlier `failure`. So the naive `conclusion != "success"`
 * filter reads a superseded failure as current and calls a green head red (#3762, which cost
 * a needless repair lane on PR #3733). GitHub itself evaluates the most recent run per
 * context, which is why `mergeable_state` disagreed with the naive read; `latestPerContext`
 * re-encodes that, once, here.
 */

/** A single check run, as the check-runs REST endpoint surfaces it (only these fields decide). */
export interface CheckRun {
	/** The context name — GitHub's own unit of evaluation, and the dedupe key. */
	readonly name: string;
	/** The run's conclusion; `null` while it is still queued or in progress. */
	readonly conclusion: string | null;
	/** ISO-8601 start time — the recency key a re-run advances. */
	readonly startedAt: string | null;
	/** ISO-8601 completion time; `null` while unconcluded. Carried for a caller's red-since anchor. */
	readonly completedAt: string | null;
	/** Server-assigned, strictly-monotonic run id — the recency tiebreak. */
	readonly id: number;
}

/** The legacy combined-status envelope, which covers commit statuses that aren't check runs. */
export interface CombinedStatus {
	/** `success` | `pending` | `failure`. */
	readonly state: string;
	/**
	 * How many statuses that state summarizes. Load-bearing: the endpoint reports `pending`
	 * for a commit with ZERO statuses (verified live — phoenix posts no commit statuses at
	 * all, so its combined state is permanently `pending`), so the state is only a signal
	 * when it actually summarizes something.
	 */
	readonly totalCount: number;
}

/** The rolled-up head-CI verdict. Three states, exhaustive: a head is red, still running, or green. */
export type ChecksConclusion = "red" | "pending" | "green";

export interface ChecksRollup {
	readonly conclusion: ChecksConclusion;
	/** The latest run per context, name-sorted — what the conclusion was actually computed over. */
	readonly latest: ReadonlyArray<CheckRun>;
	/** The latest-per-context runs that concluded red. Empty unless `conclusion` is `red`. */
	readonly failing: ReadonlyArray<CheckRun>;
	/** The latest-per-context runs that have not concluded yet. */
	readonly running: ReadonlyArray<CheckRun>;
}

/**
 * The conclusions that make a context red — GitHub's check-run vocabulary. Everything else
 * (`success`, and the explicitly non-failing `neutral` / `skipped`, plus `stale` and any
 * conclusion GitHub adds later) is non-failing: a red verdict needs positive evidence of a
 * failure, never the absence of a success.
 */
export const RED_CONCLUSIONS: ReadonlySet<string> = new Set([
	"failure",
	"timed_out",
	"cancelled",
	"action_required",
	"startup_failure",
]);

/** Is this run's conclusion a failure? A `null` (unconcluded) conclusion is never a failure. */
export const isFailing = (run: CheckRun): boolean =>
	run.conclusion !== null && RED_CONCLUSIONS.has(run.conclusion);

/** Recency order: later `startedAt` wins; equal (or absent) start times fall back to the run id. */
const moreRecent = (a: CheckRun, b: CheckRun): CheckRun => {
	const at = a.startedAt ?? "";
	const bt = b.startedAt ?? "";
	if (at !== bt) return at > bt ? a : b;
	return a.id >= b.id ? a : b;
};

/**
 * Reduce a SHA's runs to the current run per context: group by `name`, keep the most recent.
 * This is the whole defect fix — a superseded run is dropped before any conclusion is read,
 * so an earlier red for a context that has since gone green cannot contribute a failure.
 * Returned name-sorted so the output is deterministic regardless of REST page order.
 */
export const latestPerContext = (runs: ReadonlyArray<CheckRun>): ReadonlyArray<CheckRun> => {
	const byName = new Map<string, CheckRun>();
	for (const run of runs) {
		const held = byName.get(run.name);
		byName.set(run.name, held === undefined ? run : moreRecent(held, run));
	}
	return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

export interface RollupInput {
	readonly checkRuns: ReadonlyArray<CheckRun>;
	readonly combinedStatus: CombinedStatus;
}

/**
 * Roll a head's check runs + combined status into one verdict, latest-per-context.
 *
 * Red wins over pending wins over green: a failing current context is red even while other
 * contexts still run, and an unconcluded context is pending rather than green. With no signal
 * at all — no check runs and no statuses — the answer is `pending`, not `green`: nothing has
 * reported yet, and a consumer that acts on red must not be handed a green it didn't earn.
 */
export const rollupChecks = (input: RollupInput): ChecksRollup => {
	const latest = latestPerContext(input.checkRuns);
	const failing = latest.filter(isFailing);
	const running = latest.filter((run) => run.conclusion === null);
	const status = input.combinedStatus;
	const statusCounts = status.totalCount > 0;

	const conclusion: ChecksConclusion =
		failing.length > 0 || (statusCounts && status.state === "failure")
			? "red"
			: running.length > 0 || (statusCounts && status.state === "pending")
				? "pending"
				: latest.length === 0 && !statusCounts
					? "pending"
					: "green";

	return {conclusion, latest, failing, running};
};
