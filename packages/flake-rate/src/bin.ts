#!/usr/bin/env node
/**
 * `flake-rate report` CLI — the operable surface for issue #770 (epic #765 Phase 2).
 *
 * `node src/bin.ts report` reads a trailing window of one workflow's runs on a
 * branch (default `ci.yml` on `main`) via `gh api` REST, classifies each as
 * first-try-green vs rerun-to-green (the laundered-flake signal `heal-ci` produces),
 * prints the flake-rate TREND over `--bucket`-sized sub-windows, and measures the
 * window against the zero-flake budget. A blown budget exits non-zero so a CI step
 * (a NEW separate `flake-rate.yml` workflow — never a `ci.yml` job; see PR/README)
 * fails loudly; the pure core (`flake-rate.ts`, `report.ts`) is unit-tested, this
 * bin is the thin shell.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/epic-ledger`):
 * `effect/unstable/cli` for typed args/flags, the live `Github` provided over
 * `NodeServices.layer` (supplying `ChildProcessSpawner`), run via `NodeRuntime.runMain`.
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect, Layer} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {checkBudget, flakeStats, flakeTrend, ZERO_FLAKE_BUDGET} from "./flake-rate.ts";
import {Github, GithubLive} from "./github.ts";
import {renderBudget, renderTrend} from "./report.ts";

// Non-zero on a blown budget; any OTHER non-zero means the report could not run.
const BUDGET_BLOWN_EXIT_CODE = 2;

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

// Tag-only error carrying the non-zero process exit; the report is already printed.
class BudgetBlown extends Error {
	readonly _tag = "BudgetBlown";
}

const clampWindow = (n: number): number => Math.max(1, Math.min(100, n));

const report = Command.make(
	"report",
	{workflow: workflowFlag, branch: branchFlag, window: windowFlag, bucket: bucketFlag},
	Effect.fn(function* ({workflow, branch, window, bucket}) {
		const perPage = clampWindow(window);
		const runs = yield* (yield* Github).workflowRuns({workflow, branch, perPage});

		const stats = flakeStats(runs);
		const trend = flakeTrend(runs, Math.max(1, bucket));
		const verdict = checkBudget(stats, ZERO_FLAKE_BUDGET);

		yield* Console.log(`flake-rate: ${workflow} on ${branch}, trailing ${perPage} runs`);
		yield* Console.log(renderTrend(trend));
		yield* Console.log(renderBudget(verdict));

		if (!verdict.withinBudget) {
			return yield* Effect.fail(new BudgetBlown());
		}
	}),
).pipe(
	Command.withDescription(
		"Report the CI flake-rate trend over a trailing window and measure it against the zero-flake budget",
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
