/**
 * `@kampus/migrations-guard` — the fail-closed CI gate over the committed D1 migrations tree
 * (issue #1435; ADR 0108, re-grounded on the v7 layout by ADR 0309). A pure, unit-tested core
 * (`migrations-guard.ts`) decides consistency / ordering / immutability over a loaded
 * `MigrationTree` + a committed baseline; the `fs.ts` boundary loads the tree and baseline from
 * disk; the `bin.ts` shell wires the `check` (gate) and `baseline` (regenerate) commands.
 */

export {loadBaseline, loadMigrationTree, serializeBaseline} from "./fs.ts";
export {
	alchemyPrefix,
	type Baseline,
	deriveBaseline,
	evaluate,
	type GuardVerdict,
	type Migration,
	type MigrationLayout,
	type MigrationTree,
	migrationNumber,
	renderVerdict,
	type Violation,
	type ViolationKind,
} from "./migrations-guard.ts";
