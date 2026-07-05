/**
 * `@kampus/migrations-guard` — the fail-closed CI gate over the hand-authored flat D1
 * migrations tree (ADR 0108, issue #1435). A pure, unit-tested core (`migrations-guard.ts`)
 * decides consistency / ordering / immutability over a loaded `MigrationTree` + a committed
 * baseline; the `fs.ts` boundary loads the tree and baseline from disk; the `bin.ts` shell
 * wires the `check` (gate) and `baseline` (regenerate) commands.
 */

export {loadBaseline, loadMigrationTree, serializeBaseline} from "./fs.ts";
export {
	type Baseline,
	deriveBaseline,
	evaluate,
	type GuardVerdict,
	type JournalEntry,
	type MigrationTree,
	migrationNumber,
	renderVerdict,
	type Violation,
	type ViolationKind,
} from "./migrations-guard.ts";
