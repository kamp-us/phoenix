/**
 * The check-run rollup — total over the status vocabulary, fail-closed on the ambiguous rows.
 *
 * `cancelled` is bucketed **red** on purpose: a cancelled check proved nothing, and "proved nothing"
 * must not read green. An unrecognised conclusion string is red for the same reason — a conclusion
 * this module has never seen is the one case where a permissive default is guaranteed wrong (#4552).
 */
export type Rollup = "green" | "red" | "pending";

/**
 * The two fields a run must carry to be rolled up, and the whole of what these functions read.
 *
 * Structural rather than `CheckRun`, because `ship`'s own reader rolls up through here too
 * (`ShipCheckRun`, which carries an id and a check-suite join `review` has no use for). A field one
 * reader adds for itself would otherwise become a requirement on every other (#7441).
 */
export interface RollupRun {
	readonly status: string;
	readonly conclusion: string | null;
}

/** The two conclusions GitHub defines as non-blocking, plus the passing one. Every other is red. */
const PASSING = new Set(["success", "neutral", "skipped"]);

/**
 * The status token one run prints: its conclusion once completed, else its in-flight status.
 *
 * A completed run carrying no conclusion prints `unknown` rather than a vocabulary word — it is red
 * in the rollup, and naming it with a token a caller could read as passing would hide that.
 */
export const statusOf = (run: RollupRun): string =>
	run.status === "completed" ? (run.conclusion ?? "unknown") : run.status;

/** A completed run that did not pass — the single test the `red` bucket is defined by. */
export const isFailing = (run: RollupRun): boolean =>
	run.status === "completed" && !PASSING.has(run.conclusion ?? "");

/**
 * `red` on any completed run outside {@link PASSING}; `pending` when none red and any run is still in
 * flight; `green` only when every run completed and each concluded passing.
 */
export const rollupOf = (runs: ReadonlyArray<RollupRun>): Rollup => {
	let inFlight = false;
	for (const run of runs) {
		if (run.status !== "completed") inFlight = true;
		else if (isFailing(run)) return "red";
	}
	return inFlight ? "pending" : "green";
};

/**
 * The known-informational check names — ADR 0061's **denylist, fail-safe to blocking**.
 *
 * A check reaches this list by being named here and nowhere else: the default is that a new check
 * gates, so a preview-deploy flake added tomorrow blocks until someone decides otherwise. v1
 * hardcoded the same list in two scripts' `jq` and they drifted; `ship checks` reads it from here.
 */
const INFORMATIONAL = [/^deploy\b/i, /^cleanup\b/i];

export const isInformational = (name: string): boolean =>
	INFORMATIONAL.some((pattern) => pattern.test(name.trim()));

/**
 * A check that is queued and has never started. Half of the wedge test — the other half is the
 * dwell, which only a caller watching the clock can supply: running and wedged look identical in a
 * single sample, and only one of them is a human's problem (#3999).
 */
export const isStalled = (run: {
	readonly status: string;
	readonly startedAt: string | null;
}): boolean => run.status === "queued" && run.startedAt === null;
