/**
 * `@kampus/flake-rate` — the CI flake-rate metric + zero-flake budget (issue #770,
 * epic #765 Phase 2). A pure, unit-tested core (`flake-rate.ts` classifies CI runs
 * into first-try-green vs rerun-to-green and computes a trailing-window trend +
 * budget verdict, discounting flakes recorded fixed in `tests/FLAKE-INVENTORY.md`;
 * `report.ts` renders it; `inventory.ts` parses the recorded-fixed set) behind a thin
 * `effect/unstable/cli` bin (`bin.ts`) that sources the signal from `gh api`
 * workflow-runs REST. The rerun-to-green signal is the laundered flake `heal-ci`
 * produces; the zero-flake budget is the policy it is held against.
 */
export {
	type Budget,
	type BudgetVerdict,
	checkBudget,
	checkBudgetWithDiscount,
	classifyRun,
	type DiscountedBudgetVerdict,
	type DiscountedRun,
	type DiscountPartition,
	discountInventoryFixed,
	type FlakeStats,
	flakeStats,
	flakeTrend,
	type InventoryFix,
	isFlake,
	type RunClass,
	type TrendBucket,
	type WorkflowRun,
	ZERO_FLAKE_BUDGET,
} from "./flake-rate.ts";
export {type FixedEntry, parseFixedEntries} from "./inventory.ts";
export {renderBudget, renderDiscountedBudget, renderTrend} from "./report.ts";
