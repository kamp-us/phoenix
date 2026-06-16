/**
 * `crabbox-manifest` CLI — the operable adapter surface (#244).
 *
 * Reads a crabbox run-summary JSON and (optionally) a JUnit file + a logs ref,
 * stamps the head SHA (from `--commit`, else `git rev-parse HEAD` via `Git`),
 * runs the pure `buildManifest`, and emits the ADR 0054 §2 manifest JSON to
 * stdout or a `--output` path. Malformed input (bad JSON / wrong shape) or an
 * unresolvable commit fails the process non-zero — the CLI never emits a
 * half-formed or commit-blank manifest.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/epic-ledger`'s bin):
 * `effect/unstable/cli` for typed flags, `NodeServices.layer` for the file/process
 * platform, run via `NodeRuntime.runMain`.
 */
import {readFileSync, writeFileSync} from "node:fs";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect, Layer} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {buildManifest} from "./adapter.ts";
import {Git, GitLive} from "./commit.ts";
import {CrabboxParseError, parseJUnit, parseRunSummaryJson} from "./crabbox.ts";
import {manifestToJson} from "./Manifest.ts";

/** Read a file as UTF-8, lowering an IO fault into the adapter's typed parse error. */
const readText = (path: string): Effect.Effect<string, CrabboxParseError> =>
	Effect.try({
		try: () => readFileSync(path, "utf8"),
		catch: (cause) => new CrabboxParseError({message: `cannot read ${path}: ${String(cause)}`}),
	});

const writeText = (path: string, contents: string): Effect.Effect<void, CrabboxParseError> =>
	Effect.try({
		try: () => writeFileSync(path, contents),
		catch: (cause) => new CrabboxParseError({message: `cannot write ${path}: ${String(cause)}`}),
	});

const runSummaryFlag = Flag.string("run-summary").pipe(
	Flag.withDescription("Path to crabbox's machine-readable run-summary JSON"),
);
const junitFlag = Flag.string("junit").pipe(
	Flag.optional,
	Flag.withDescription("Path to the --artifact-glob'd JUnit XML (omitted → zeroed tests)"),
);
const logsFlag = Flag.string("logs").pipe(
	Flag.withDefault("crabbox:stdout"),
	Flag.withDescription("Reference (path/URL) to the captured run logs"),
);
const commitFlag = Flag.string("commit").pipe(
	Flag.optional,
	Flag.withDescription("Head SHA to stamp (omitted → git rev-parse HEAD)"),
);
const runUrlFlag = Flag.string("run-url").pipe(Flag.optional, Flag.withDescription("Run URL"));
const environmentFlag = Flag.string("environment").pipe(
	Flag.optional,
	Flag.withDescription("Environment/stage the run executed in"),
);
const outputFlag = Flag.string("output").pipe(
	Flag.optional,
	Flag.withDescription("Write the manifest here instead of stdout"),
);

const adapter = Command.make(
	"crabbox-manifest",
	{
		runSummary: runSummaryFlag,
		junit: junitFlag,
		logs: logsFlag,
		commit: commitFlag,
		runUrl: runUrlFlag,
		environment: environmentFlag,
		output: outputFlag,
	},
	(args) =>
		Effect.gen(function* () {
			const summaryText = yield* readText(args.runSummary);
			const summary = yield* parseRunSummaryJson(summaryText);

			const junitXml = args.junit._tag === "Some" ? yield* readText(args.junit.value) : null;
			const tests = parseJUnit(junitXml);

			const provided =
				args.commit._tag === "Some" && args.commit.value.trim().length > 0
					? args.commit.value.trim()
					: undefined;
			const commit = provided ?? (yield* Effect.flatMap(Git, (git) => git.headSha()));

			const manifest = buildManifest({
				summary,
				tests,
				commit,
				logsRef: args.logs,
				timestamp: summary.finishedAt ?? new Date().toISOString(),
				...(args.runUrl._tag === "Some" ? {runUrl: args.runUrl.value} : {}),
				...(args.environment._tag === "Some" ? {environment: args.environment.value} : {}),
			});

			const json = manifestToJson(manifest);
			if (args.output._tag === "Some") {
				yield* writeText(args.output.value, json);
			} else {
				yield* Console.log(json.trimEnd());
			}
		}),
).pipe(Command.withDescription("Map a crabbox run to an ADR 0054 §2 run-evidence manifest"));

const AppLayer = GitLive.pipe(Layer.provideMerge(NodeServices.layer));

adapter.pipe(Command.run({version: "0.0.0"}), Effect.provide(AppLayer), NodeRuntime.runMain);
