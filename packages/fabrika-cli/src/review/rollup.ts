/**
 * The check-run rollup — total over the status vocabulary, fail-closed on the ambiguous rows.
 *
 * `cancelled` is bucketed **red** on purpose: a cancelled check proved nothing, and "proved nothing"
 * must not read green. An unrecognised conclusion string is red for the same reason — a conclusion
 * this module has never seen is the one case where a permissive default is guaranteed wrong (#4552).
 */
import type {CheckRun} from "../io/pulls.ts";

export type Rollup = "green" | "red" | "pending";

/** The two conclusions GitHub defines as non-blocking, plus the passing one. Every other is red. */
const PASSING = new Set(["success", "neutral", "skipped"]);

/**
 * The status token one run prints: its conclusion once completed, else its in-flight status.
 *
 * A completed run carrying no conclusion prints `unknown` rather than a vocabulary word — it is red
 * in the rollup, and naming it with a token a caller could read as passing would hide that.
 */
export const statusOf = (run: CheckRun): string =>
	run.status === "completed" ? (run.conclusion ?? "unknown") : run.status;

/**
 * `red` on any completed run outside {@link PASSING}; `pending` when none red and any run is still in
 * flight; `green` only when every run completed and each concluded passing.
 */
export const rollupOf = (runs: ReadonlyArray<CheckRun>): Rollup => {
	let inFlight = false;
	for (const run of runs) {
		if (run.status !== "completed") inFlight = true;
		else if (!PASSING.has(run.conclusion ?? "")) return "red";
	}
	return inFlight ? "pending" : "green";
};
