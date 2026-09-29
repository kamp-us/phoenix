#!/usr/bin/env node
/**
 * `release-watch check` — compare every `@demlik/*` pin in the root catalog with npm's `latest`
 * and file or update one issue per lagging package (#10133). The decision is `release-watch.ts`;
 * this reads the catalog, the registry and the open bot issues, then performs the writes.
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect, FileSystem, Layer} from "effect";
import * as Schema from "effect/Schema";
import {Command, Flag} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {watchedPins} from "./catalog.ts";
import {fileIssue, openBotIssues, targetFromEnv, updateIssue} from "./github.ts";
import {npmLatest} from "./registry.ts";
import {planReleaseWatch, renderVerdict} from "./release-watch.ts";

const workspaceFlag = Flag.string("workspace").pipe(
	Flag.withDefault("pnpm-workspace.yaml"),
	Flag.withDescription("the pnpm-workspace.yaml whose root catalog holds the pins"),
);

const dryRunFlag = Flag.boolean("dry-run").pipe(
	Flag.withDefault(false),
	Flag.withDescription("print the verdicts and write no issue"),
);

/** The root catalog could not be read, or holds no watched entry to compare. */
class CatalogError extends Schema.TaggedError<CatalogError>()(
	"@kampus/release-watch/CatalogError",
	{
		message: Schema.String,
	},
) {}

const check = Command.make(
	"check",
	{workspace: workspaceFlag, dryRun: dryRunFlag},
	Effect.fn(function* ({workspace, dryRun}) {
		const fs = yield* FileSystem.FileSystem;
		const catalog = watchedPins(yield* fs.readFileString(workspace));
		if (catalog._tag === "Unreadable") return yield* new CatalogError({message: catalog.reason});
		if (catalog.pins.length === 0) {
			return yield* new CatalogError({message: "the root catalog has no @demlik/* entry"});
		}

		const target = yield* targetFromEnv(process.env);

		const watched = yield* Effect.forEach(
			catalog.pins,
			(pin) => Effect.map(npmLatest(pin.name), (latest) => ({pin, latest})),
			{concurrency: "unbounded"},
		);
		const verdicts = planReleaseWatch(watched, yield* openBotIssues(target));

		for (const verdict of verdicts) {
			yield* Console.log(`release-watch: ${renderVerdict(verdict)}`);
			if (dryRun) continue;
			if (verdict._tag === "File") {
				const filed = yield* fileIssue(target, verdict.issue);
				yield* Console.log(`release-watch: filed ${filed.html_url}`);
			} else if (verdict._tag === "Update") {
				const updated = yield* updateIssue(target, verdict.issueNumber, verdict.issue);
				yield* Console.log(`release-watch: updated ${updated.html_url}`);
			}
		}
		if (verdicts.every((verdict) => verdict._tag === "Current")) {
			yield* Console.log("release-watch: every @demlik/* pin is current");
		}
		if (dryRun) yield* Console.log("release-watch: dry run, no issue written");
	}),
).pipe(
	Command.withDescription(
		"Compare the catalog's @demlik/* pins with npm latest and file or update one issue per lagging package",
	),
);

const cli = Command.make("release-watch").pipe(
	Command.withSubcommands([check]),
	Command.withDescription("Watch first-party @demlik/* releases against the catalog pins (#10133)"),
);

const AppLayer = FetchHttpClient.layer.pipe(Layer.provideMerge(NodeServices.layer));

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(AppLayer), NodeRuntime.runMain);
