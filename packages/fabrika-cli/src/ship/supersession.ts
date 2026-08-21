/**
 * Which check contexts at a head belong to a workflow run something newer already replaced.
 *
 * A repo whose CI declares `concurrency: {group, cancel-in-progress}` cancels its own older run
 * whenever the suite re-fires **without the head moving** — a close/reopen, a base refresh, a rapid
 * second push. The older run's contexts conclude `cancelled` at the same `head_sha` the newer run is
 * still proving, and the dependent aggregator job (`ci-required`) makes it worse: the newer run has
 * not created its own aggregator context yet, so latest-per-context resolves to the cancelled one.
 * `ship checks` then read a healthy head as a hard red and routed a green PR to `heal-ci` (#6834).
 *
 * **Only `cancelled` is reclassified, and only into `pending`.** The rollup's fail-closed default
 * (`../review/rollup.ts`) is load-bearing everywhere else: a cancel proved nothing, and "proved
 * nothing" must never read green. What supersession adds is the one case where something else is
 * proving it right now — so the answer is "wait", not "pass". A `failure` stays red at every level
 * of supersession, and a cancel with no newer run of its workflow at that head stays red too.
 */
import type {ShipCheckRun, WorkflowRun} from "./github.ts";

/**
 * The suites whose workflow run a later run of the same workflow replaced at this head.
 *
 * Read off run ids rather than timestamps: two runs started in the same second are ordered by id and
 * by nothing else the list carries.
 */
export const supersededSuites = (runs: ReadonlyArray<WorkflowRun>): ReadonlySet<number> => {
	const newest = new Map<number, number>();
	for (const run of runs) {
		const held = newest.get(run.workflowId);
		if (held === undefined || run.id > held) newest.set(run.workflowId, run.id);
	}
	const superseded = new Set<number>();
	for (const run of runs) {
		if (run.checkSuiteId !== null && (newest.get(run.workflowId) ?? run.id) > run.id) {
			superseded.add(run.checkSuiteId);
		}
	}
	return superseded;
};

/** A cancelled check run published by a superseded suite — in flight elsewhere, not failed here. */
export const isSuperseded = (run: ShipCheckRun, suites: ReadonlySet<number>): boolean =>
	run.conclusion === "cancelled" && suites.has(run.checkSuiteId);
