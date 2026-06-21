#!/usr/bin/env node
/**
 * `orphan-sweep sweep` — the operable surface for the integration-stage leak (#690).
 *
 * Lists the account's Worker + D1 resources and the repo's open PRs (behind the
 * injectable `Cloudflare` / `Github` services so the pure core stays IO-free), computes
 * the deletion plan via `computeSweepPlan`, prints it, and — ONLY with `--execute` —
 * deletes the planned set. DRY-RUN by default: with no flag it prints what it WOULD
 * delete and exits 0 without touching the account.
 *
 * The catastrophe guard lives in the pure core (`orphan-sweep.ts`): prod, named-dev
 * (`--protect`), and open-PR resources are NEVER in the plan, so `--execute` can only
 * ever delete an orphan `it-*` (and, with `--sweep-closed-previews`, a closed PR's
 * `pr-<n>`). Credentials come from the environment at runtime
 * (`$CLOUDFLARE_API_TOKEN` / `$CLOUDFLARE_ACCOUNT_ID`), never from source.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/flake-rate`): `effect/unstable/cli`
 * for typed args/flags, the live `Cloudflare` + `Github` provided over `NodeServices.layer`
 * (supplying `ChildProcessSpawner`), run via `NodeRuntime.runMain`.
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect, Layer} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {Cloudflare, CloudflareLive} from "./cloudflare.ts";
import {Github, GithubLive} from "./github.ts";
import {computeSweepPlan, type Protection} from "./orphan-sweep.ts";
import {renderPlan, renderSummary} from "./report.ts";

const executeFlag = Flag.boolean("execute").pipe(
	Flag.withDescription("actually delete the planned resources (default: dry-run, print only)"),
);

// `atLeast(0)` makes `--protect` a 0-or-more repeated flag yielding `string[]`.
const protectFlag = Flag.string("protect").pipe(
	Flag.atLeast(0),
	Flag.withDescription("a named-dev stage to NEVER sweep (repeatable); prod is always protected"),
);

const sweepClosedPreviewsFlag = Flag.boolean("sweep-closed-previews").pipe(
	Flag.withDescription(
		"also delete pr-<n> previews of CLOSED PRs (off by default; #690 mandate is it-* only)",
	),
);

const sweep = Command.make(
	"sweep",
	{
		execute: executeFlag,
		protect: protectFlag,
		sweepClosedPreviews: sweepClosedPreviewsFlag,
	},
	Effect.fn(function* ({execute, protect, sweepClosedPreviews}) {
		const cloudflare = yield* Cloudflare;
		const github = yield* Github;

		const resources = yield* cloudflare.listResources();
		const openPrNumbers = yield* github.openPrNumbers();

		const protection: Protection = {
			// `prod` is always protected, on top of any `--protect` named-dev stages.
			protectedStages: ["prod", ...protect],
			openPrNumbers,
			sweepClosedPreviews,
		};
		const plan = computeSweepPlan(resources, protection);

		yield* Console.log(renderSummary(plan, execute));
		yield* Console.log(renderPlan(plan));

		if (!execute) {
			yield* Console.log("  (dry-run — pass --execute to delete; no resources touched)");
			return;
		}

		for (const planned of plan.toDelete) {
			yield* cloudflare.deleteResource(planned.resource);
			yield* Console.log(`  deleted ${planned.resource.kind} ${planned.resource.name}`);
		}
		yield* Console.log(`orphan-sweep: deleted ${plan.toDelete.length} resource(s)`);
	}),
).pipe(
	Command.withDescription(
		"Compute (and with --execute, delete) the orphan it-* integration-stage leak on the shared CF account (#690)",
	),
);

const cli = Command.make("orphan-sweep").pipe(
	Command.withSubcommands([sweep]),
	Command.withDescription(
		"Orphan integration-stage sweep for the shared Cloudflare account (#690)",
	),
);

// Both live services need `ChildProcessSpawner`, which `NodeServices.layer` provides;
// `provideMerge` keeps the Node services the CLI runtime needs (argv, stdout).
const AppLayer = Layer.mergeAll(CloudflareLive, GithubLive).pipe(
	Layer.provideMerge(NodeServices.layer),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(AppLayer), NodeRuntime.runMain);
