/**
 * The `crabbox-manifest` tool — `pipeline-cli crabbox-manifest …`.
 *
 * The crabbox → ADR 0054 §2 run-evidence adapter (#244), moved into the pipeline-cli
 * registry (epic #994, Phase 2 / #1002). Reads a crabbox run-summary JSON and
 * (optionally) a JUnit file + a logs ref, stamps the head SHA (from `--commit`, else
 * `git rev-parse HEAD` via `Git`), runs the pure `buildManifest`, and emits the manifest
 * JSON to stdout or a `--output` path. Malformed input (bad JSON / wrong shape) or an
 * unresolvable commit fails the process non-zero — the CLI never emits a half-formed or
 * commit-blank manifest.
 *
 * The flag surface + manifest schema + stdout/`--output` byte contract is preserved from
 * the former package's `bin.ts` — ship-it/review-code parse the emitted `manifest.json`
 * byte-sensitively (`schemaVersion == 1`, `commit`, `checks[]`). The handler requires
 * `Git`, and `GitLive` is baked in here with `Command.provide(...)` so the registered
 * command's residual requirement is the Node platform union (`GitLive` needs
 * `ChildProcessSpawner`, a `NodeServices` member the bin provides) — per the registry
 * seam, a tool self-contains its services. Only the `Command.run`/`Effect.provide`/
 * `runMain` wiring is dropped — the shared `pipeline-cli` bin owns the run boundary.
 */
import {readFileSync, writeFileSync} from "node:fs";
import {Console, Effect, Schema} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {buildManifest} from "./adapter.ts";
import {Git, GitLive} from "./commit.ts";
import {CrabboxParseError, parseJUnit, parseRunSummaryJson} from "./crabbox.ts";
import {Check, manifestToJson} from "./Manifest.ts";

/** A file of externally-produced checks: a single `Check` object OR an array of them. */
const ExtraChecksFile = Schema.Union([Check, Schema.Array(Check)]);
const decodeExtraChecks = Schema.decodeUnknownSync(ExtraChecksFile);

/**
 * Parse an `--extra-checks` file into a `Check[]`. Tolerant of object-or-array;
 * a malformed shape fails the process non-zero (same contract as a bad run-summary)
 * so the manifest never carries a half-formed check.
 */
const parseExtraChecks = (text: string): Effect.Effect<ReadonlyArray<Check>, CrabboxParseError> =>
	Effect.try({
		try: () => {
			const decoded = decodeExtraChecks(JSON.parse(text));
			return Array.isArray(decoded) ? decoded : [decoded];
		},
		catch: (cause) =>
			new CrabboxParseError({message: `malformed --extra-checks: ${String(cause)}`}),
	});

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
const extraChecksFlag = Flag.string("extra-checks").pipe(
	Flag.optional,
	Flag.withDescription(
		"Path to a JSON Check (or Check[]) produced outside crabbox, folded into checks[] (e.g. the #1836 bundle assertion)",
	),
);

export const crabboxManifestCommand = Command.make(
	"crabbox-manifest",
	{
		runSummary: runSummaryFlag,
		junit: junitFlag,
		logs: logsFlag,
		commit: commitFlag,
		runUrl: runUrlFlag,
		environment: environmentFlag,
		output: outputFlag,
		extraChecks: extraChecksFlag,
	},
	(args) =>
		Effect.gen(function* () {
			const summaryText = yield* readText(args.runSummary);
			const summary = yield* parseRunSummaryJson(summaryText);

			const junitXml = args.junit._tag === "Some" ? yield* readText(args.junit.value) : null;
			const tests = parseJUnit(junitXml);

			const extraChecks =
				args.extraChecks._tag === "Some"
					? yield* Effect.flatMap(readText(args.extraChecks.value), parseExtraChecks)
					: [];

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
				extraChecks,
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
).pipe(
	Command.withDescription("Map a crabbox run to an ADR 0054 §2 run-evidence manifest"),
	Command.provide(GitLive),
);
