/**
 * Pure, IO-free rendering of a `SweepPlan`. The `--execute` vs dry-run distinction is the
 * bin's; this only describes the plan.
 */
import type {SweepPlan} from "./orphan-sweep.ts";

export const renderSummary = (plan: SweepPlan, execute: boolean): string => {
	const verb = execute ? "DELETING" : "would delete";
	return `orphan-sweep: ${verb} ${plan.toDelete.length} resource(s), keeping ${plan.kept.length}`;
};

export const renderPlan = (plan: SweepPlan): string => {
	if (plan.toDelete.length === 0) {
		return "  (nothing to delete — no orphan it-*, closed-preview, or stale dev/test resources found)";
	}
	return plan.toDelete
		.map((d) => `  - ${d.resource.kind} ${d.resource.name} (${d.reason}, stage ${d.stage})`)
		.join("\n");
};
