/**
 * Pure rendering of a `SweepPlan` into the plain text the bin prints. IO-free: the bin
 * passes the rendered lines to `Console.log`. The `--execute` vs dry-run distinction is
 * the bin's; this only describes the plan.
 */
import type {SweepPlan} from "./orphan-sweep.ts";

/** A one-line summary: how many resources would be deleted vs kept. */
export const renderSummary = (plan: SweepPlan, execute: boolean): string => {
	const verb = execute ? "DELETING" : "would delete";
	return `orphan-sweep: ${verb} ${plan.toDelete.length} resource(s), keeping ${plan.kept.length}`;
};

/** The delete set, one `kind name (reason, stage)` per line — empty plan renders a clear note. */
export const renderPlan = (plan: SweepPlan): string => {
	if (plan.toDelete.length === 0) {
		return "  (nothing to delete — no orphan it-*, closed-preview, or stale dev/test resources found)";
	}
	return plan.toDelete
		.map((d) => `  - ${d.resource.kind} ${d.resource.name} (${d.reason}, stage ${d.stage})`)
		.join("\n");
};
