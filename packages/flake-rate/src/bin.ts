#!/usr/bin/env node
/**
 * `flake-rate report` CLI — the operable surface for issue #770 (epic #765 Phase 2).
 *
 * `node src/bin.ts report` reads a trailing window of one workflow's runs on a
 * branch (default `ci.yml` on `main`) via `gh api` REST, classifies each as
 * first-try-green vs rerun-to-green (the laundered-flake signal `heal-ci` produces),
 * prints the flake-rate TREND over `--bucket`-sized sub-windows, and measures the
 * window against the zero-flake budget. A rerun-to-green run whose flake is recorded
 * `fixed` in `tests/FLAKE-INVENTORY.md` and predates that fix is DISCOUNTED from the
 * budget (issue #812) — an already-cured flake aging out of the window is not a live
 * regression. A blown budget (post-discount) exits non-zero so a CI step (a NEW
 * separate `flake-rate.yml` workflow — never a `ci.yml` job; see PR/README) fails
 * loudly; the pure core (`flake-rate.ts`, `report.ts`, `inventory.ts`) is unit-tested,
 * this bin is the thin shell.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/epic-ledger`):
 * `effect/unstable/cli` for typed args/flags, the live `Github` provided over
 * `NodeServices.layer` (supplying `ChildProcessSpawner`), run via `NodeRuntime.runMain`.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect, Layer} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {checkBudgetWithDiscount, flakeTrend, ZERO_FLAKE_BUDGET} from "./flake-rate.ts";
import {Github, GithubLive} from "./github.ts";
import {renderDiscountedBudget, renderTrend} from "./report.ts";

// Non-zero on a blown budget; any OTHER non-zero means the report could not run.
const BUDGET_BLOWN_EXIT_CODE = 2;

// tests/FLAKE-INVENTORY.md lives two levels up from this package's src/ in the repo.
const DEFAULT_INVENTORY = fileURLToPath(
	new URL("../../../tests/FLAKE-INVENTORY.md", import.meta.url),
);

const workflowFlag = Flag.string("workflow").pipe(
	Flag.withDefault("ci.yml"),
	Flag.withDescription("workflow file basename whose runs to measure (default ci.yml)"),
);

const branchFlag = Flag.string("branch").pipe(
	Flag.withDefault("main"),
	Flag.withDescription("branch whose runs to measure (default main)"),
);

const windowFlag = Flag.integer("window").pipe(
	Flag.withDefault(50),
	Flag.withDescription("trailing window size in runs, capped at 100 (default 50)"),
);

const bucketFlag = Flag.integer("bucket").pipe(
	Flag.withDefault(10),
	Flag.withDescription("trend bucket size in runs (default 10)"),
);

const inventoryFlag = Flag.string("inventory").pipe(
	Flag.withDefault(DEFAULT_INVENTORY),
	Flag.withDescription(
		"path to FLAKE-INVENTORY.md, the recorded-fixed set the budget discounts against",
	),
);

// Tag-only error carrying the non-zero process exit; the report is already printed.
class BudgetBlown extends Error {
	readonly _tag = "BudgetBlown";
}

const clampWindow = (n: number): number => Math.max(1, Math.min(100, n));

// Read the inventory markdown; a missing/unreadable file means "no recorded fixes" (an
// empty discount set), never a hard failure — the budget then measures every run.
const readInventory = (path: string): string => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
};

const report = Command.make(
	"report",
	{
		workflow: workflowFlag,
		branch: branchFlag,
		window: windowFlag,
		bucket: bucketFlag,
		inventory: inventoryFlag,
	},
	Effect.fn(function* ({workflow, branch, window, bucket, inventory}) {
		const perPage = clampWindow(window);
		const github = yield* Github;
		const runs = yield* github.workflowRuns({workflow, branch, perPage});
		const fixes = yield* github.inventoryFixes(readInventory(inventory));

		const trend = flakeTrend(runs, Math.max(1, bucket));
		const discounted = checkBudgetWithDiscount(runs, fixes, ZERO_FLAKE_BUDGET);

		yield* Console.log(`flake-rate: ${workflow} on ${branch}, trailing ${perPage} runs`);
		yield* Console.log(renderTrend(trend));
		yield* Console.log(renderDiscountedBudget(discounted));

		if (!discounted.verdict.withinBudget) {
			return yield* Effect.fail(new BudgetBlown());
		}
	}),
).pipe(
	Command.withDescription(
		"Report the CI flake-rate trend over a trailing window and measure it against the zero-flake budget (discounting inventory-fixed flakes)",
	),
);

const flakeRate = Command.make("flake-rate").pipe(
	Command.withSubcommands([report]),
	Command.withDescription("CI flake-rate metric + zero-flake budget (issue #770, epic #765)"),
);

// `GithubLive` requires `ChildProcessSpawner`, which `NodeServices.layer` provides;
// `provideMerge` keeps the Node services the CLI runtime needs (argv, stdout).
const AppLayer = GithubLive.pipe(Layer.provideMerge(NodeServices.layer));

flakeRate.pipe(
	Command.run({version: "0.0.0"}),
	// BudgetBlown is the expected CI-fail signal, its report already on stdout — turn
	// it into a bare non-zero exit so NodeRuntime doesn't also dump a stack trace.
	Effect.catchTag("BudgetBlown", () => Effect.sync(() => process.exit(BUDGET_BLOWN_EXIT_CODE))),
	Effect.provide(AppLayer),
	NodeRuntime.runMain,
);
