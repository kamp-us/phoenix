/**
 * `@kampus/flake-rate` pure core — turn a list of CI workflow runs into a
 * flake-rate trend and a budget verdict. IO-free and total: every function here
 * is a deterministic transform over the already-decoded `WorkflowRun[]`. The
 * `gh api` boundary lives in `github.ts`; this module never touches the network.
 *
 * The flake signal is `run_attempt`. A workflow run that finished `success` at
 * attempt 1 is **first-try-green**; one that finished `success` at attempt > 1 was
 * **rerun-to-green** — the laundered-flake signal `heal-ci` produces when it
 * reruns a known transient exactly once (see ADR + tests/FLAKE-INVENTORY.md). A
 * rerun-to-green is a flake that reached green by retry, not by determinism, so it
 * is exactly the regression the zero-flake budget is held against.
 */

/** A CI workflow run, decoded to only the fields the flake signal needs. */
export interface WorkflowRun {
	readonly runNumber: number;
	readonly runAttempt: number;
	/** GitHub `conclusion` of the run's final attempt, e.g. `success`, `failure`, `null` (in-progress). */
	readonly conclusion: string | null;
	readonly headBranch: string;
	/** ISO-8601 creation timestamp; the trend orders and buckets runs by this. */
	readonly createdAt: string;
}

/**
 * How a resolved run is classified for the flake signal. An in-progress or
 * non-`success`/non-`failure` run is `unresolved` and excluded from the rate
 * denominator — the metric measures laundered-flake among runs that reached a
 * verdict, not pipeline noise.
 */
export type RunClass = "first-try-green" | "rerun-to-green" | "failed" | "unresolved";

export const classifyRun = (run: WorkflowRun): RunClass => {
	if (run.conclusion === "success") {
		return run.runAttempt > 1 ? "rerun-to-green" : "first-try-green";
	}
	if (run.conclusion === "failure" || run.conclusion === "timed_out") {
		return "failed";
	}
	return "unresolved";
};

/** A run is a laundered flake iff it reached green only after a rerun. */
export const isFlake = (run: WorkflowRun): boolean => classifyRun(run) === "rerun-to-green";

/** The flake tally over a set of runs: the rate's numerator, denominator, and value. */
export interface FlakeStats {
	readonly total: number;
	readonly firstTryGreen: number;
	readonly rerunToGreen: number;
	readonly failed: number;
	/** rerun-to-green ÷ (first-try-green + rerun-to-green); `0` when no run reached green. */
	readonly flakeRate: number;
}

const greenDenominator = (firstTryGreen: number, rerunToGreen: number): number =>
	firstTryGreen + rerunToGreen;

/**
 * Tally a set of runs into `FlakeStats`. The flake rate is rerun-to-green over the
 * runs that reached green (first-try + rerun) — a `failure` is a red build, not a
 * laundered flake, so it is counted but kept out of the rate denominator; an
 * unresolved run is ignored entirely.
 */
export const flakeStats = (runs: ReadonlyArray<WorkflowRun>): FlakeStats => {
	let firstTryGreen = 0;
	let rerunToGreen = 0;
	let failed = 0;
	for (const run of runs) {
		switch (classifyRun(run)) {
			case "first-try-green":
				firstTryGreen += 1;
				break;
			case "rerun-to-green":
				rerunToGreen += 1;
				break;
			case "failed":
				failed += 1;
				break;
			case "unresolved":
				break;
		}
	}
	const green = greenDenominator(firstTryGreen, rerunToGreen);
	return {
		total: firstTryGreen + rerunToGreen + failed,
		firstTryGreen,
		rerunToGreen,
		failed,
		flakeRate: green === 0 ? 0 : rerunToGreen / green,
	};
};

/** One point on the flake-rate trend: a contiguous bucket of runs and its stats. */
export interface TrendBucket {
	readonly index: number;
	readonly stats: FlakeStats;
}

/**
 * The flake rate as a TREND, not a snapshot: split the runs (oldest → newest) into
 * `bucketSize`-run buckets and tally each. A regression shows as a non-zero
 * `flakeRate` (or a rising one) in the most recent buckets, which a single
 * window-wide average would hide. Runs are sorted by `createdAt` ascending so the
 * last bucket is always the most recent activity; a trailing partial bucket is
 * kept (it is the live edge of the window).
 */
export const flakeTrend = (
	runs: ReadonlyArray<WorkflowRun>,
	bucketSize: number,
): ReadonlyArray<TrendBucket> => {
	if (bucketSize < 1) {
		throw new RangeError(`bucketSize must be >= 1, got ${bucketSize}`);
	}
	const ordered = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	const buckets: Array<TrendBucket> = [];
	for (let start = 0; start < ordered.length; start += bucketSize) {
		buckets.push({
			index: buckets.length,
			stats: flakeStats(ordered.slice(start, start + bucketSize)),
		});
	}
	return buckets;
};

/** The zero-flake budget: the policy the metric is measured against. */
export interface Budget {
	/** Max rerun-to-green runs tolerated in the window. Zero-flake ⇒ `0`. */
	readonly maxRerunToGreen: number;
}

/** The pinned zero-flake budget (issue #770 / epic #765): zero net-new laundered flakes. */
export const ZERO_FLAKE_BUDGET: Budget = {maxRerunToGreen: 0};

export interface BudgetVerdict {
	readonly withinBudget: boolean;
	readonly budget: Budget;
	readonly stats: FlakeStats;
	/** rerun-to-green runs over budget; `0` when within budget. */
	readonly overBy: number;
}

/**
 * Measure the window's stats against the budget. The budget is blown the moment
 * rerun-to-green exceeds `maxRerunToGreen` (for the zero-flake budget, the moment a
 * single laundered flake appears) — `withinBudget: false` is the self-evident
 * alarm. Per the package policy (README): a blown budget means the inventory must
 * gain an entry and a determinism child must be filed.
 */
export const checkBudget = (
	stats: FlakeStats,
	budget: Budget = ZERO_FLAKE_BUDGET,
): BudgetVerdict => {
	const overBy = Math.max(0, stats.rerunToGreen - budget.maxRerunToGreen);
	return {withinBudget: overBy === 0, budget, stats, overBy};
};
