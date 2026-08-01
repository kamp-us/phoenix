/**
 * The `eval-harness` tool — `pipeline-cli eval-harness check|report|cases`.
 *
 * The graded-corpus apparatus for adjudicating a stochastic model swap per stage (epic
 * #1842), plus the ingestion of `/skill-creator`-authored eval sets (epic #4649). Three live
 * surfaces:
 *
 *   pipeline-cli eval-harness check <manifest>   # decode a corpus manifest; exit non-zero on a bad one
 *   pipeline-cli eval-harness report <rows>      # the graded two-axis scorecard over runner rows
 *   pipeline-cli eval-harness cases <path>       # decode an authored eval set; exit non-zero on a bad one
 *
 * `check` (issue #1848) validates the on-disk corpus format. `report` (issue #1853) is the
 * top of the vertical slice: it reads the runner's graded `{entry, grade, spend}` rows and
 * renders the per-(stage × model) scorecard — pass-rate + per-run token spend + repair-churn
 * cost — as a human table (default) or stable JSON (`--json`), the evidence the model-tiering
 * decision (#1576) consumes. It presents measurement, never a recommendation. `cases` (issue
 * #4674) validates a `/skill-creator` `evals/evals.json` and prints the tier each case derives to.
 *
 * Thin IO shell over the pure cores (the `token-spend` / `readme-guard` idiom): read the file,
 * decode, render. An unreadable path and a malformed/mismatched input both exit non-zero.
 */
import {Console, Effect, FileSystem, Result} from "effect";
import * as Schema from "effect/Schema";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {decodeManifest, STAGES} from "./corpus.ts";
import {
	type BaselineKey,
	buildScorecard,
	decodeReportInput,
	renderTable,
	toJson,
} from "./report.ts";
import {decodeSkillEvalSet, tierCounts} from "./skill-eval-set.ts";

const GATE_FAIL_EXIT_CODE = 1;

// A named manifest path that could not be read — a hard error (exit 1), not a skip.
class ManifestUnreadable extends Schema.TaggedErrorClass<ManifestUnreadable>()(
	"ManifestUnreadable",
	{
		path: Schema.String,
	},
) {}

const manifestArg = Argument.string("manifest").pipe(
	Argument.withDescription("path to a corpus manifest JSON file to validate against the schema"),
);

const check = Command.make(
	"check",
	{manifest: manifestArg},
	Effect.fn(function* ({manifest}) {
		const run = Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const text = yield* Effect.mapError(
				fs.readFileString(manifest),
				() => new ManifestUnreadable({path: manifest}),
			);
			const result = decodeManifest(text);
			if (Result.isFailure(result)) {
				yield* Console.error(
					`eval-harness: ${manifest} is not a valid corpus manifest (${result.failure.reason}): ${result.failure.message}`,
				);
				return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
			}
			yield* Console.log(`eval-harness: ${manifest} is a valid corpus manifest.`);
		});
		yield* run.pipe(
			Effect.catchTag("ManifestUnreadable", (e) =>
				Effect.gen(function* () {
					yield* Console.error(`eval-harness: cannot read manifest ${e.path}`);
					return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
				}),
			),
		);
	}),
).pipe(
	Command.withDescription(
		"Validate a corpus manifest file against the schema (exit non-zero on a bad one)",
	),
);

// A named report-input path that could not be read — a hard error (exit 1), not a skip.
class RowsUnreadable extends Schema.TaggedErrorClass<RowsUnreadable>()("RowsUnreadable", {
	path: Schema.String,
}) {}

const rowsArg = Argument.string("rows").pipe(
	Argument.withDescription(
		"path to a JSON file of the runner's graded rows (a serialized RunRow[])",
	),
);

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription(
		"emit the stable machine-readable JSON scorecard instead of the human table",
	),
);

const baselineStageFlag = Flag.string("baseline-stage").pipe(
	Flag.optional,
	Flag.withDescription(
		`the stage of the baseline cell net saving is measured against (one of: ${STAGES.join(", ")})`,
	),
);

const baselineModelFlag = Flag.string("baseline-model").pipe(
	Flag.optional,
	Flag.withDescription("the model of the baseline cell (paired with --baseline-stage)"),
);

const isStage = (s: string): s is (typeof STAGES)[number] =>
	(STAGES as ReadonlyArray<string>).includes(s);

const report = Command.make(
	"report",
	{
		rows: rowsArg,
		json: jsonFlag,
		baselineStage: baselineStageFlag,
		baselineModel: baselineModelFlag,
	},
	Effect.fn(function* ({rows, json, baselineStage, baselineModel}) {
		const run = Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const text = yield* Effect.mapError(
				fs.readFileString(rows),
				() => new RowsUnreadable({path: rows}),
			);
			const decoded = decodeReportInput(text);
			if (Result.isFailure(decoded)) {
				yield* Console.error(
					`eval-harness: ${rows} is not a valid runner-rows file (${decoded.failure.reason}): ${decoded.failure.message}`,
				);
				return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
			}

			// A --baseline-stage that isn't one of the known stages is a user error, not a silent
			// no-baseline: fail loudly so a typo can't quietly drop the net-saving axis.
			let baseline: BaselineKey | undefined;
			if (baselineStage._tag === "Some") {
				const stage = baselineStage.value;
				if (!isStage(stage)) {
					yield* Console.error(
						`eval-harness: --baseline-stage '${stage}' is not a known stage (${STAGES.join(", ")})`,
					);
					return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
				}
				baseline = {stage, model: baselineModel._tag === "Some" ? baselineModel.value : null};
			}

			const scorecard = buildScorecard(
				baseline === undefined ? {rows: decoded.success} : {rows: decoded.success, baseline},
			);
			yield* Console.log(json ? toJson(scorecard) : renderTable(scorecard));
		});
		yield* run.pipe(
			Effect.catchTag("RowsUnreadable", (e) =>
				Effect.gen(function* () {
					yield* Console.error(`eval-harness: cannot read runner-rows file ${e.path}`);
					return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
				}),
			),
		);
	}),
).pipe(
	Command.withDescription(
		"Render the graded two-axis scorecard (pass-rate + token spend + churn cost per stage×model) — evidence for #1576, not a recommendation",
	),
);

// A named eval-set path that could not be read — a hard error (exit 1), not a skip.
class EvalSetUnreadable extends Schema.TaggedErrorClass<EvalSetUnreadable>()("EvalSetUnreadable", {
	path: Schema.String,
}) {}

const evalSetArg = Argument.string("path").pipe(
	Argument.withDescription(
		"path to a /skill-creator evals/evals.json — the eval set one skill's authoring session produced",
	),
);

const cases = Command.make(
	"cases",
	{path: evalSetArg},
	Effect.fn(function* ({path}) {
		const run = Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const text = yield* Effect.mapError(
				fs.readFileString(path),
				() => new EvalSetUnreadable({path}),
			);
			const result = decodeSkillEvalSet(text);
			if (Result.isFailure(result)) {
				yield* Console.error(
					`eval-harness: ${path} is not a valid skill eval set (${result.failure.reason}): ${result.failure.message}`,
				);
				return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
			}
			const set = result.success;
			// A schema-valid set with zero cases would report green while checking nothing — the
			// zero-scope pass ADR 0092 forbids. It reds with a named reason like any other bad set.
			if (set.cases.length === 0) {
				yield* Console.error(
					`eval-harness: ${path} is not a usable skill eval set (empty-set): it decodes, but carries zero eval cases (ADR 0092 — zero scope reds)`,
				);
				return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
			}
			const counts = tierCounts(set);
			yield* Console.log(
				`eval-harness: ${path} is a valid skill eval set — skill '${set.skillName}', ${set.cases.length} case(s): ${counts.deterministic} deterministic, ${counts.graded} graded.`,
			);
			for (const evalCase of set.cases) {
				yield* Console.log(
					`  case ${evalCase.id} [${evalCase.tier}] ${evalCase.assertions.length} assertion(s)`,
				);
			}
		});
		yield* run.pipe(
			Effect.catchTag("EvalSetUnreadable", (e) =>
				Effect.gen(function* () {
					yield* Console.error(`eval-harness: cannot read eval set ${e.path}`);
					return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
				}),
			),
		);
	}),
).pipe(
	Command.withDescription(
		"Validate a /skill-creator-authored eval set and print each case's derived execution tier (exit non-zero with a named reason on a bad one)",
	),
);

export const evalHarnessCommand = Command.make("eval-harness").pipe(
	Command.withSubcommands([check, report, cases]),
	Command.withDescription(
		"Graded per-stage corpus + scorecard + authored-eval-set ingestion: the labeled ground-truth format, the model-tiering evidence report, and the /skill-creator eval-set decode (#1848, #1853, #4674)",
	),
);
