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
 *
 * An unconcluded context splits two ways, and conflating them is its own defect (#3999): a run
 * that is genuinely in flight settles on its own, while one WEDGED in the queue (`status:
 * queued` with a `null` `started_at`) never starts — a `fanout-guard` job sat that way for ~2.5h
 * and blocked a green PR while every surface an agent reads said only "pending." Both are
 * `pending` to the gate (fail-closed, never green); the split is the diagnosis a waiter needs to
 * tell "still running" from "stranded in queue" instead of waiting the wedge out.
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
	/**
	 * `queued` | `in_progress` | `completed` | … . Optional: a caller that doesn't need the
	 * running/wedged split may omit it, and an absent status resolves to `running`, never
	 * `wedged` — the wedged verdict needs positive evidence, never an absent field.
	 */
	readonly status?: string | null;
}

/**
 * A check suite, as `commits/{sha}/check-suites` surfaces it. Suites are carried for DIAGNOSIS
 * only — see `inertSuites`; no suite can make a head pending.
 */
export interface CheckSuite {
	readonly id: number;
	/** `queued` | `in_progress` | `completed`. */
	readonly status: string | null;
	/** How many check runs the suite actually attached. Zero ⇒ inert. */
	readonly latestCheckRunsCount: number;
	/** The producing app (`github-actions`, `vercel`, `sentry`, …), for the operator-facing note. */
	readonly appSlug: string | null;
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
	/** Unconcluded runs that are genuinely in flight — they settle on their own. */
	readonly running: ReadonlyArray<CheckRun>;
	/** Unconcluded runs stranded in the queue: they will not start without an operator lever. */
	readonly wedged: ReadonlyArray<CheckRun>;
	/**
	 * Check suites with zero attached check runs — the inert third-party suites (vercel, sentry,
	 * cloudflare-workers-and-pages) that sit `queued` forever on every head. Reported so the
	 * "queued suites are holding this PR pending" reading is visibly false, never acted on: a
	 * suite with no runs contributes NO pending-ness, by construction (#3999).
	 */
	readonly inertSuites: ReadonlyArray<CheckSuite>;
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

/**
 * Is this run stranded in the queue rather than running? Both tells must hold — still `queued`
 * AND never started. A queued run that already carries a `started_at` is in flight, and a run
 * with no `status` at all is indeterminate; either way it reads as running, so a wedge is only
 * ever declared on positive evidence of both.
 */
export const isWedged = (run: CheckRun): boolean =>
	run.conclusion === null && run.status === "queued" && run.startedAt === null;

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
	/**
	 * The head's check suites, if the caller read them. Diagnosis only: a suite's runs already
	 * speak for it in `checkRuns`, and a suite with none has nothing to say — so suites never
	 * move the conclusion in either direction, and omitting them changes no verdict.
	 */
	readonly suites?: ReadonlyArray<CheckSuite>;
}

/**
 * Roll a head's check runs + combined status into one verdict, latest-per-context.
 *
 * Red wins over pending wins over green: a failing current context is red even while other
 * contexts still run, and an unconcluded context is pending rather than green. With no signal
 * at all — no check runs and no statuses — the answer is `pending`, not `green`: nothing has
 * reported yet, and a consumer that acts on red must not be handed a green it didn't earn.
 *
 * A wedged context is pending exactly as a running one is — the split is reported alongside,
 * never folded into the verdict, so no consumer that branches on `conclusion` can read a wedge
 * as anything but "not green" (#3999).
 */
export const rollupChecks = (input: RollupInput): ChecksRollup => {
	const latest = latestPerContext(input.checkRuns);
	const failing = latest.filter(isFailing);
	const unconcluded = latest.filter((run) => run.conclusion === null);
	const wedged = unconcluded.filter(isWedged);
	const running = unconcluded.filter((run) => !isWedged(run));
	const status = input.combinedStatus;
	const statusCounts = status.totalCount > 0;

	const conclusion: ChecksConclusion =
		failing.length > 0 || (statusCounts && status.state === "failure")
			? "red"
			: unconcluded.length > 0 || (statusCounts && status.state === "pending")
				? "pending"
				: latest.length === 0 && !statusCounts
					? "pending"
					: "green";

	return {
		conclusion,
		latest,
		failing,
		running,
		wedged,
		inertSuites: (input.suites ?? []).filter((suite) => suite.latestCheckRunsCount === 0),
	};
};
