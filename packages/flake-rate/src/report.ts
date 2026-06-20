/**
 * Pure rendering of the flake-rate report — the operator-readable surface. Kept
 * IO-free and total so it is unit-testable; `bin.ts` only prints these strings.
 * Planner-agnostic on the destination (stdout, a CI step summary, a committed
 * artifact); this module just produces the text + the budget alarm line.
 */
import type {
	BudgetVerdict,
	DiscountedBudgetVerdict,
	FlakeStats,
	TrendBucket,
} from "./flake-rate.ts";

const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

const statsLine = (stats: FlakeStats): string =>
	`flake-rate=${pct(stats.flakeRate)} ` +
	`(rerun-to-green=${stats.rerunToGreen}/${stats.firstTryGreen + stats.rerunToGreen} green, ` +
	`failed=${stats.failed}, total=${stats.total})`;

/** Render the trailing-window trend, oldest bucket first, so a rising tail is visible. */
export const renderTrend = (buckets: ReadonlyArray<TrendBucket>): string => {
	if (buckets.length === 0) {
		return "trend: (no resolved runs in window)";
	}
	const rows = buckets.map((b) => `  bucket ${b.index}: ${statsLine(b.stats)}`);
	return ["trend (oldest → newest):", ...rows].join("\n");
};

/**
 * Render the budget verdict as a single self-evident alarm line. Within budget →
 * a `✓ within zero-flake budget` line; blown → a `✗ BUDGET BLOWN` line naming the
 * overage and the required follow-up (inventory entry + determinism child), so the
 * regression is impossible to miss in CI output.
 */
export const renderBudget = (verdict: BudgetVerdict): string => {
	const head = `window: ${statsLine(verdict.stats)}`;
	if (verdict.withinBudget) {
		return [
			head,
			`✓ within zero-flake budget (max rerun-to-green=${verdict.budget.maxRerunToGreen})`,
		].join("\n");
	}
	return [
		head,
		`✗ BUDGET BLOWN — ${verdict.stats.rerunToGreen} rerun-to-green run(s), ` +
			`budget=${verdict.budget.maxRerunToGreen} (over by ${verdict.overBy}).`,
		"  A laundered flake regressed. Required: add an entry to tests/FLAKE-INVENTORY.md " +
			"and file a determinism child under epic #765.",
	].join("\n");
};

/**
 * Render the inventory-aware budget verdict (issue #812). The discount is made
 * VISIBLE (AC #3): a `discounted N rerun-to-green as inventory-fixed` line names
 * each discounted run + the recorded fix it is attributed to, the verdict is the
 * post-discount one (`renderBudget` over the remaining runs), and the raw rerun-to-green
 * count is shown so a reader sees the number was *lowered by a named discount*, never
 * silently. When nothing is discounted this is identical to `renderBudget`.
 */
export const renderDiscountedBudget = (verdict: DiscountedBudgetVerdict): string => {
	const lines: Array<string> = [];
	const {discounted, rawStats} = verdict;
	if (discounted.length > 0) {
		lines.push(
			`discounted ${discounted.length} rerun-to-green as inventory-fixed ` +
				`(of ${rawStats.rerunToGreen} raw rerun-to-green in window):`,
		);
		for (const d of discounted) {
			lines.push(`  - run #${d.run.runNumber} (${d.run.createdAt}) — fixed by ${d.fix.ref}`);
		}
	}
	lines.push(renderBudget(verdict.verdict));
	return lines.join("\n");
};
