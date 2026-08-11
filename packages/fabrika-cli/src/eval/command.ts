/**
 * The `eval` verb group — `fabrika eval check|report|cases|run|graded|keeps|baseline`.
 *
 * The graded-corpus apparatus for adjudicating a stochastic model swap per stage (epic
 * #1842), plus the ingestion of `/skill-creator`-authored eval sets (epic #4649). Seven live
 * surfaces:
 *
 *   fabrika eval check <manifest>   # decode a corpus manifest; exit non-zero on a bad one
 *   fabrika eval report <rows>      # the graded two-axis scorecard over runner rows
 *   fabrika eval cases <path>       # decode an authored eval set; exit non-zero on a bad one
 *   fabrika eval run <path>         # execute an eval set unattended, emit the capture manifest
 *   fabrika eval graded <path>      # five runs per graded case, the median, and the head-bound record
 *   fabrika eval keeps <path>       # print the ruled KEEP corpus and what already pins each row
 *   fabrika eval baseline …         # record the v1 cost baseline, and answer the phase-1 ceiling
 *
 * `check` (issue #1848) validates the on-disk corpus format. `report` (issue #1853) is the
 * top of the vertical slice: it reads the runner's graded `{entry, grade, spend}` rows and
 * renders the per-(stage × model) scorecard — pass-rate + per-run token spend + repair-churn
 * cost — as a human table (default) or stable JSON (`--json`), the evidence the model-tiering
 * decision (#1576) consumes. It presents measurement, never a recommendation. `cases` (issue
 * #4674) validates a `/skill-creator` `evals/evals.json` and prints the tier each case derives to.
 * `graded` (issue #4678) is the judgment tier: it runs each graded case five times through the
 * grader the case's authoring session defined, takes the median, and emits the head-bound eval
 * record. `keeps` (issue #4823) prints the ruled KEEP corpus — the enumeration that replaced the
 * two-artifact join every consumer used to re-run by hand. `baseline` (issue #4679) records the
 * committed v1 cost baseline from measured spend rows and answers the phase-1 ceiling against it.
 *
 * Thin IO shell over the pure cores (the `token-spend` / `readme-guard` idiom): read the file,
 * decode, render. Every refusal seats on `./codes.ts` — an unreadable path exits `FAILED`, an
 * outcome the verb proved exits on its own code.
 */
import {Console, Crypto, Effect, FileSystem, Path, Result} from "effect";
import * as Schema from "effect/Schema";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import {
	DEFAULT_SPEND_LEDGER_PATH,
	type LedgerRow,
	persistSpendRows,
	readSpendLedger,
} from "../spend/ledger.ts";
import {FAILED} from "../verb.ts";
import {VERSION} from "../version.ts";
import {emit as emitEvalRecord} from "../wire/eval-record.ts";
import {
	ABOVE_BASELINE,
	BASELINE_INCOMPARABLE,
	INTEGRITY_VIOLATION,
	MALFORMED_DOCUMENT,
	NO_MEASUREMENT,
	RUNS_NOT_EXECUTED,
	ZERO_SCOPE,
} from "./codes.ts";
import {decodeManifest, REVIEW_SURFACES, type ReviewSurface, STAGES} from "./corpus.ts";
import {
	buildCostBaseline,
	compareToBaseline,
	costBaselineToJson,
	decodeCostBaseline,
	foldLedgerRows,
	renderBaselineComparison,
	renderCostBaseline,
} from "./cost-baseline.ts";
import {
	buildEvalRecord,
	candidateOutputOf,
	composeGraderPrompt,
	gradableCase,
	graderResponseOf,
	readGraderVerdict,
	runGradedAxis,
} from "./graded-axis.ts";
import {decodeIncidentProvenance} from "./incident-provenance.ts";
import {
	type BaselineKey,
	buildScorecard,
	decodeReportInput,
	renderTable,
	toJson,
} from "./report.ts";
import {
	decodeRuledKeeps,
	keepsToJson,
	renderKeeps,
	ruledKeepsViolations,
	withCoverage,
} from "./ruled-keeps.ts";
import {decodeSkillEvalSet, tierCounts} from "./skill-eval-set.ts";
import {
	buildClaudeArgs,
	buildLedger,
	captureToJson,
	EVAL_ARMS,
	executeRuns,
	isStageName,
	ledgerToJson,
	parseArms,
	planEvalRuns,
	renderLedger,
	suiteExecuted,
} from "./spawn.ts";
import {claudeExecutor, claudeVersion, locateTranscript, readTranscript} from "./spawn-io.ts";

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

const check = leafCommand(
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
					`fabrika eval: ${manifest} is not a valid corpus manifest (${result.failure.reason}): ${result.failure.message}`,
				);
				return yield* Effect.sync(() => process.exit(MALFORMED_DOCUMENT));
			}
			yield* Console.log(`fabrika eval: ${manifest} is a valid corpus manifest.`);
		});
		yield* run.pipe(
			Effect.catchTag("ManifestUnreadable", (e) =>
				Effect.gen(function* () {
					yield* Console.error(`fabrika eval: cannot read manifest ${e.path}`);
					return yield* Effect.sync(() => process.exit(FAILED));
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Validate a corpus manifest against the schema."),
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
	Flag.withDescription(
		"the model of the baseline cell (paired with --baseline-stage) — normalized the same way as --model, so an alias still matches the cell recorded under its canonical id",
	),
);

const baselineSurfaceFlag = Flag.string("baseline-surface").pipe(
	Flag.optional,
	Flag.withDescription(
		`the review surface of the baseline cell, required with --baseline-stage review (one of: ${REVIEW_SURFACES.join(", ")})`,
	),
);

const isStage = (s: string): s is (typeof STAGES)[number] =>
	(STAGES as ReadonlyArray<string>).includes(s);

const isReviewSurface = (s: string): s is ReviewSurface =>
	(REVIEW_SURFACES as ReadonlyArray<string>).includes(s);

const report = leafCommand(
	"report",
	{
		rows: rowsArg,
		json: jsonFlag,
		baselineStage: baselineStageFlag,
		baselineModel: baselineModelFlag,
		baselineSurface: baselineSurfaceFlag,
	},
	Effect.fn(function* ({rows, json, baselineStage, baselineModel, baselineSurface}) {
		const run = Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const text = yield* Effect.mapError(
				fs.readFileString(rows),
				() => new RowsUnreadable({path: rows}),
			);
			const decoded = decodeReportInput(text);
			if (Result.isFailure(decoded)) {
				yield* Console.error(
					`fabrika eval: ${rows} is not a valid runner-rows file (${decoded.failure.reason}): ${decoded.failure.message}`,
				);
				return yield* Effect.sync(() => process.exit(MALFORMED_DOCUMENT));
			}

			// A --baseline-stage that isn't one of the known stages is a user error, not a silent
			// no-baseline: fail loudly so a typo can't quietly drop the net-saving axis. The surface
			// rules below are the same discipline one level down — a `review` baseline that names no
			// surface names no single grading regime, so it cannot identify a baseline cell at all
			// (ADR 0243 §4).
			let baseline: BaselineKey | undefined;
			if (baselineStage._tag === "Some") {
				const stage = baselineStage.value;
				if (!isStage(stage)) {
					yield* Console.error(
						`fabrika eval: --baseline-stage '${stage}' is not a known stage (${STAGES.join(", ")})`,
					);
					return yield* Effect.sync(() => process.exit(FAILED));
				}
				if (baselineSurface._tag === "Some" && stage !== "review") {
					yield* Console.error(
						`fabrika eval: --baseline-surface only applies to --baseline-stage review, not '${stage}'`,
					);
					return yield* Effect.sync(() => process.exit(FAILED));
				}
				if (stage === "review" && baselineSurface._tag === "None") {
					yield* Console.error(
						`fabrika eval: --baseline-stage review needs --baseline-surface (${REVIEW_SURFACES.join(", ")}) — a review pass-rate is one grading regime, never an average of two`,
					);
					return yield* Effect.sync(() => process.exit(FAILED));
				}
				const model = baselineModel._tag === "Some" ? baselineModel.value : null;
				if (baselineSurface._tag === "Some") {
					const surface = baselineSurface.value;
					if (!isReviewSurface(surface)) {
						yield* Console.error(
							`fabrika eval: --baseline-surface '${surface}' is not a known review surface (${REVIEW_SURFACES.join(", ")})`,
						);
						return yield* Effect.sync(() => process.exit(FAILED));
					}
					baseline = {stage, surface, model};
				} else {
					baseline = {stage, model};
				}
			}

			const scorecard = buildScorecard(
				baseline === undefined ? {rows: decoded.success} : {rows: decoded.success, baseline},
			);
			yield* Console.log(json ? toJson(scorecard) : renderTable(scorecard));
		});
		yield* run.pipe(
			Effect.catchTag("RowsUnreadable", (e) =>
				Effect.gen(function* () {
					yield* Console.error(`fabrika eval: cannot read runner-rows file ${e.path}`);
					return yield* Effect.sync(() => process.exit(FAILED));
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Render the graded two-axis eval scorecard."),
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

const cases = leafCommand(
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
					`fabrika eval: ${path} is not a valid skill eval set (${result.failure.reason}): ${result.failure.message}`,
				);
				return yield* Effect.sync(() => process.exit(MALFORMED_DOCUMENT));
			}
			const set = result.success;
			// A schema-valid set with zero cases would report green while checking nothing — the
			// zero-scope pass ADR 0092 forbids. It reds with a named reason like any other bad set.
			if (set.cases.length === 0) {
				yield* Console.error(
					`fabrika eval: ${path} is not a usable skill eval set (empty-set): it decodes, but carries zero eval cases (ADR 0092 — zero scope reds)`,
				);
				return yield* Effect.sync(() => process.exit(ZERO_SCOPE));
			}
			const counts = tierCounts(set);
			yield* Console.log(
				`fabrika eval: ${path} is a valid skill eval set — skill '${set.skillName}', ${set.cases.length} case(s): ${counts.deterministic} deterministic, ${counts.graded} graded.`,
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
					yield* Console.error(`fabrika eval: cannot read eval set ${e.path}`);
					return yield* Effect.sync(() => process.exit(FAILED));
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Validate an eval set and print each case's execution tier."),
	Command.withDescription(
		"Validate a /skill-creator-authored eval set and print each case's derived execution tier (exit non-zero with a named reason on a bad one)",
	),
);

const stageFlag = Flag.string("stage").pipe(
	Flag.withDescription(
		`the pipeline stage this skill's eval set exercises — the capture manifest's join key (one of: ${STAGES.join(", ")})`,
	),
);

const pluginDirFlag = Flag.string("plugin-dir").pipe(
	Flag.withDescription(
		"the candidate skill's plugin directory — loaded for the with-skill arm only, which is what makes the two arms differ",
	),
);

const modelFlag = Flag.string("model").pipe(
	Flag.withDescription(
		"the model every run is pinned to — required, because a scorecard is only comparable when it names one; a known alias is normalized to its canonical id, anything else runs as given",
	),
);

const armsFlag = Flag.string("arms").pipe(
	Flag.withDefault("with-skill,without-skill"),
	Flag.withDescription(`comma-separated arms to run (${EVAL_ARMS.join(", ")})`),
);

const jsonSchemaFlag = Flag.string("json-schema").pipe(
	Flag.optional,
	Flag.withDescription(
		"path to a JSON schema for the decision artifact; its text is passed to --json-schema and the validated object becomes the capture run's artifact",
	),
);

const timeoutFlag = Flag.integer("timeout-ms").pipe(
	Flag.withDefault(900_000),
	Flag.withDescription(
		"the stated wall-clock bound per run; a run past it is a typed TimedOut case",
	),
);

const ledgerOutFlag = Flag.string("out").pipe(
	Flag.optional,
	Flag.withDescription(
		"write the full run ledger (every run's typed outcome + the capture manifest) here",
	),
);

const captureOutFlag = Flag.string("capture-out").pipe(
	Flag.optional,
	Flag.withDescription(
		"write the bare capture manifest here — the file `fabrika eval report` and collectFromCapture consume unchanged",
	),
);

const dryRunFlag = Flag.boolean("dry-run").pipe(
	Flag.withDescription("print the argv of every planned run and spawn nothing"),
);

const spendLedgerFlag = Flag.string("spend-ledger").pipe(
	Flag.withDefault(DEFAULT_SPEND_LEDGER_PATH),
	Flag.withDescription(
		`append one spend line per completed run here — the durable ledger the roll-up reads (default: ${DEFAULT_SPEND_LEDGER_PATH})`,
	),
);

/**
 * `run` — execute an eval set unattended and emit the capture manifest the existing collector reads.
 *
 * Its supported invocation sites are an operator's shell and a `review-skill` review-stage spawn.
 * **No CI workflow invokes this path**, and none is shipped with it: the founder ruling on epic #4649
 * (comment 5153280445) removed model-in-the-loop execution from CI on a **cost** constraint — there
 * are no credits for model runs inside the CI provider. That is a cost constraint, not a principle,
 * recorded so a future reader knows what would have to change to revisit it. #4681's deterministic
 * regression-floor leg is the separate, model-free thing CI does run.
 */
const runCommand = leafCommand(
	"run",
	{
		path: evalSetArg,
		stage: stageFlag,
		pluginDir: pluginDirFlag,
		model: modelFlag,
		arms: armsFlag,
		jsonSchema: jsonSchemaFlag,
		timeoutMs: timeoutFlag,
		out: ledgerOutFlag,
		captureOut: captureOutFlag,
		spendLedger: spendLedgerFlag,
		dryRun: dryRunFlag,
	},
	Effect.fn(function* (opts) {
		const run = Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const text = yield* Effect.mapError(
				fs.readFileString(opts.path),
				() => new EvalSetUnreadable({path: opts.path}),
			);
			const decoded = decodeSkillEvalSet(text);
			if (Result.isFailure(decoded)) {
				yield* Console.error(
					`fabrika eval: ${opts.path} is not a valid skill eval set (${decoded.failure.reason}): ${decoded.failure.message}`,
				);
				return yield* Effect.sync(() => process.exit(MALFORMED_DOCUMENT));
			}
			const set = decoded.success;
			if (set.cases.length === 0) {
				yield* Console.error(
					`fabrika eval: ${opts.path} carries zero eval cases — refusing to report a green suite that ran nothing (ADR 0092)`,
				);
				return yield* Effect.sync(() => process.exit(ZERO_SCOPE));
			}
			if (!isStageName(opts.stage)) {
				yield* Console.error(
					`fabrika eval: --stage '${opts.stage}' is not a known stage (${STAGES.join(", ")})`,
				);
				return yield* Effect.sync(() => process.exit(FAILED));
			}
			const arms = parseArms(opts.arms);
			if (arms === null) {
				yield* Console.error(
					`fabrika eval: --arms '${opts.arms}' names something that is not an arm (${EVAL_ARMS.join(", ")})`,
				);
				return yield* Effect.sync(() => process.exit(FAILED));
			}

			let jsonSchema: string | null = null;
			if (opts.jsonSchema._tag === "Some") {
				const schemaPath = opts.jsonSchema.value;
				jsonSchema = yield* Effect.mapError(
					fs.readFileString(schemaPath),
					() => new EvalSetUnreadable({path: schemaPath}),
				);
			}

			// A session id that cannot be minted leaves the run's transcript unlocatable, so there is
			// nothing to degrade to — `orDie` rather than a branch nobody could act on.
			const crypto = yield* Crypto.Crypto;
			const plans = yield* planEvalRuns({
				cases: set.cases,
				arms,
				model: opts.model,
				pluginDir: opts.pluginDir,
				jsonSchema,
				sessionId: () => Effect.orDie(crypto.randomUUIDv4),
			});

			if (opts.dryRun) {
				for (const plan of plans) {
					yield* Console.log(
						`case ${plan.caseId} [${plan.arm}] claude ${buildClaudeArgs(plan).join(" ")}`,
					);
				}
				return;
			}

			const outcomes = yield* executeRuns({
				plans,
				executor: claudeExecutor({timeoutMs: opts.timeoutMs}),
				locateTranscript: (sessionId) => locateTranscript(sessionId),
				loadTranscript: readTranscript,
			});
			const ledger = buildLedger({
				skillName: set.skillName,
				stage: opts.stage,
				model: opts.model,
				cliVersion: yield* claudeVersion(),
				// Read here rather than in the core: `buildLedger` stays a pure function of its inputs,
				// which is what lets the unit tier assert an exact recorded row.
				recordedAt: new Date().toISOString(),
				outcomes,
			});

			// The one durable write, on the completion path and nowhere else: the suite has finished, so
			// every row here measures work that already happened. A ledger that cannot be written is
			// reported and nothing more — the measurement is a by-product of the run, so failing to
			// record it must never change what the run reports (epic #4779's no-gate ruling).
			for (const note of yield* persistSpendRows(opts.spendLedger, ledger.spendRows)) {
				yield* Console.error(`fabrika eval: ${note}`);
			}

			if (opts.out._tag === "Some") yield* fs.writeFileString(opts.out.value, ledgerToJson(ledger));
			if (opts.captureOut._tag === "Some") {
				yield* fs.writeFileString(opts.captureOut.value, captureToJson(ledger.capture));
			}
			yield* Console.log(renderLedger(ledger));

			// The suite always completes; the exit code reports only whether every case EXECUTED.
			// Whether they passed is the oracle's answer, read off the capture manifest downstream.
			if (!suiteExecuted(ledger.summary)) {
				yield* Console.error(
					`fabrika eval: ${ledger.summary.failed} of ${ledger.summary.planned} run(s) did not execute — ${JSON.stringify(ledger.summary.byFailure)}`,
				);
				return yield* Effect.sync(() => process.exit(RUNS_NOT_EXECUTED));
			}
		});
		yield* run.pipe(
			Effect.catchTag("EvalSetUnreadable", (e) =>
				Effect.gen(function* () {
					yield* Console.error(`fabrika eval: cannot read ${e.path}`);
					return yield* Effect.sync(() => process.exit(FAILED));
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Execute a skill's eval set unattended, both arms."),
	Command.withDescription(
		"Execute a skill's eval set unattended (both arms) and emit the capture manifest the existing collector consumes — for an operator's shell or a review-skill spawn, never a CI job (#4676)",
	),
);

const surfaceFlag = Flag.string("surface").pipe(
	Flag.optional,
	Flag.withDescription(
		`the review surface being graded, required with --stage review (one of: ${REVIEW_SURFACES.join(", ")}) — a pass rate measures one grading regime`,
	),
);

const shaFlag = Flag.string("sha").pipe(
	Flag.withDescription(
		"the head commit the review ran against — the record is bound to it, and a record bound to nothing attests no tree",
	),
);

const harnessFlag = Flag.string("harness").pipe(
	Flag.withDefault(VERSION),
	Flag.withDescription(
		`the harness version the measurement is pinned to (#4637 ruling 4; default: ${VERSION})`,
	),
);

const recordOutFlag = Flag.string("out").pipe(
	Flag.optional,
	Flag.withDescription("also write the record's bytes here; they always go to stdout"),
);

/**
 * `graded` — run a skill's graded cases five times each, take the median, and emit the head-bound
 * eval record (#4678).
 *
 * Its supported invocation sites are an operator's shell and the `review` stage on a PR that changes
 * a skill. **No CI workflow invokes it**, for `run`'s reason above: the founder ruling on #4649
 * removed model-in-the-loop execution from CI on a **cost** constraint — no credits for model runs
 * inside the CI provider — recorded as a cost constraint and not a principle, so a future reader
 * knows what would have to change to revisit it. CI's leg is #4681, which verifies that the record
 * exists, is bound to the head, and clears the bar; it runs no model.
 *
 * The exit code reports **whether a measurement exists**, never whether it was good. A below-bar
 * rate exits `0` with its number in the record, because the ruled bar is #4681's judgement.
 *
 * **The run count is not a flag.** Five is the ruled count (#4637 ruling 4), and a record produced at
 * one run is indistinguishable at the gate from one produced at five — same token, same clause shape,
 * same rate — so a flag would make the ruled protocol optional at no cost to the record, under the
 * exact cost pressure that makes cutting it tempting. `runGradedAxis`'s `runs` parameter stays for the
 * unit tier; re-adding a flag needs #4681 asserting `every case.runs === GRADED_RUNS` first.
 */
const graded = leafCommand(
	"graded",
	{
		path: evalSetArg,
		stage: stageFlag,
		surface: surfaceFlag,
		model: modelFlag,
		pluginDir: pluginDirFlag,
		sha: shaFlag,
		harness: harnessFlag,
		timeoutMs: timeoutFlag,
		out: recordOutFlag,
	},
	Effect.fn(function* (opts) {
		const run = Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			// The invocation is validated *before* the set is read, so the two kinds of failure stay
			// apart: a bad --stage/--surface is the operator's own mistake and records nothing, while
			// every refusal below is a fact about the eval set and therefore leaves a record.
			if (!isStageName(opts.stage)) {
				yield* Console.error(
					`fabrika eval: --stage '${opts.stage}' is not a known stage (${STAGES.join(", ")})`,
				);
				return yield* Effect.sync(() => process.exit(FAILED));
			}
			let surface: ReviewSurface | null = null;
			if (opts.surface._tag === "Some") {
				if (!isReviewSurface(opts.surface.value)) {
					yield* Console.error(
						`fabrika eval: --surface '${opts.surface.value}' is not a known review surface (${REVIEW_SURFACES.join(", ")})`,
					);
					return yield* Effect.sync(() => process.exit(FAILED));
				}
				surface = opts.surface.value;
			}
			if (opts.stage === "review" && surface === null) {
				yield* Console.error(
					"fabrika eval: --stage review needs --surface — a review pass rate is one grading regime, never an average of two (ADR 0243 §4)",
				);
				return yield* Effect.sync(() => process.exit(FAILED));
			}

			const cli = (yield* claudeVersion()) ?? "unknown";
			const pins = {model: opts.model, cli, harness: opts.harness};
			const cell = {stage: opts.stage, surface, model: opts.model};
			/**
			 * Emit the `UNRECORDABLE` record for a run that never reached a case, then exit on `code`.
			 *
			 * Founder ruling (#4678 comment 5247447078): a set that could not be read, one that does not
			 * conform, and one carrying no graded case each emit an **explicit** record naming which it
			 * was. Silence reaches #4681 as `missing`, which is byte-identical to a review that never ran
			 * the axis — the exact ambiguity ADR 0253 Amendment 1 exists to remove. The exit code is
			 * unchanged, so a caller still tells the three apart without parsing the record.
			 */
			const recordNoMeasurement = (noMeasurement: string, code: number) =>
				Effect.gen(function* () {
					const built = buildEvalRecord({
						sha: opts.sha,
						recordedAt: new Date().toISOString(),
						cell,
						pins,
						results: [],
						noMeasurement,
					});
					if (built._tag === "Unusable") {
						yield* Console.error(`fabrika eval: cannot record this run — ${built.reason}`);
						return yield* Effect.sync(() => process.exit(FAILED));
					}
					const bytes = emitEvalRecord(built.record);
					if (opts.out._tag === "Some") yield* fs.writeFileString(opts.out.value, bytes);
					yield* Console.log(bytes);
					yield* Console.error(`fabrika eval: ${noMeasurement} — recorded UNRECORDABLE`);
					return yield* Effect.sync(() => process.exit(code));
				});

			const read = yield* Effect.result(fs.readFileString(opts.path));
			if (Result.isFailure(read)) {
				return yield* recordNoMeasurement(`${opts.path} could not be read`, FAILED);
			}
			const decoded = decodeSkillEvalSet(read.success);
			if (Result.isFailure(decoded)) {
				return yield* recordNoMeasurement(
					`${opts.path} is not a valid skill eval set (${decoded.failure.reason}): ${decoded.failure.message}`,
					MALFORMED_DOCUMENT,
				);
			}

			const cases = decoded.success.cases
				.filter((evalCase) => evalCase.tier === "graded")
				.map(gradableCase);
			// A set with no graded case has nothing for this axis to measure, so reporting a green over
			// it is the zero-scope pass ADR 0092 forbids. It records rather than exits silent, for
			// `recordNoMeasurement`'s reason.
			if (cases.length === 0) {
				return yield* recordNoMeasurement(`${opts.path} carries no graded case`, ZERO_SCOPE);
			}

			const crypto = yield* Crypto.Crypto;
			const executor = claudeExecutor({timeoutMs: opts.timeoutMs});
			const invoke = (
				evalCase: ReturnType<typeof gradableCase>,
				prompt: string,
				pluginDir: string | null,
			) =>
				Effect.gen(function* () {
					const sessionId = yield* Effect.orDie(crypto.randomUUIDv4);
					return yield* executor({
						caseId: evalCase.id,
						tier: "graded",
						arm: "with-skill",
						sessionId,
						prompt,
						model: opts.model,
						pluginDir,
						jsonSchema: null,
					});
				});

			const results = yield* runGradedAxis({
				cases,
				runOnce: ({evalCase}) =>
					Effect.gen(function* () {
						const candidate = candidateOutputOf(
							yield* invoke(evalCase, evalCase.prompt, opts.pluginDir),
						);
						if (candidate._tag !== "Output") return candidate;
						// The grader loads no plugin: it judges what the candidate produced against the
						// authored expectations, and running the skill again inside the grader would make
						// the judgement depend on a second execution nobody scored.
						return readGraderVerdict(
							graderResponseOf(
								yield* invoke(
									evalCase,
									composeGraderPrompt({evalCase, candidateOutput: candidate.text}),
									null,
								),
							),
						);
					}),
			});

			const built = buildEvalRecord({
				sha: opts.sha,
				recordedAt: new Date().toISOString(),
				cell,
				pins,
				results,
			});
			if (built._tag === "Unusable") {
				yield* Console.error(`fabrika eval: cannot record this run — ${built.reason}`);
				return yield* Effect.sync(() => process.exit(FAILED));
			}

			const bytes = emitEvalRecord(built.record);
			if (opts.out._tag === "Some") yield* fs.writeFileString(opts.out.value, bytes);
			yield* Console.log(bytes);
			if (built.record.outcome === "UNRECORDABLE") {
				yield* Console.error(
					`fabrika eval: every run of all ${results.length} graded case(s) returned no verdict — the record is UNRECORDABLE, which is not a below-bar number`,
				);
				return yield* Effect.sync(() => process.exit(NO_MEASUREMENT));
			}
		});
		yield* run;
	}),
).pipe(
	Command.withShortDescription("Run a skill's graded cases five times and record the median."),
	Command.withDescription(
		"Run each graded case five times through the authored grader, take the median, and emit the head-bound eval record — for an operator's shell or a review-stage spawn, never a CI job (#4678)",
	),
);

// A named enumeration/ledger path that could not be read — a hard error (exit 1), not a skip.
class KeepsUnreadable extends Schema.TaggedErrorClass<KeepsUnreadable>()("KeepsUnreadable", {
	path: Schema.String,
}) {}

const keepsArg = Argument.string("path").pipe(
	Argument.withDescription(
		"path to the ruled-KEEP enumeration (incident-corpus/ruled-keeps.json) — the committed membership list",
	),
);

const provenanceFlag = Flag.string("provenance").pipe(
	Flag.optional,
	Flag.withDescription(
		"path to the provenance ledger the coverage column is joined from (default: provenance.json beside the enumeration)",
	),
);

/**
 * `keeps` — print the ruled KEEP corpus (#4823).
 *
 * Membership was ruled in #4642 and never written down, so every consumer re-ran a two-artifact
 * join by hand. This verb is the read that replaces it. Coverage is joined live from the
 * provenance ledger rather than stored, so the two can never disagree.
 */
const keeps = leafCommand(
	"keeps",
	{path: keepsArg, provenance: provenanceFlag, json: jsonFlag},
	Effect.fn(function* (opts) {
		const run = Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const text = yield* Effect.mapError(
				fs.readFileString(opts.path),
				() => new KeepsUnreadable({path: opts.path}),
			);
			const decoded = decodeRuledKeeps(text);
			if (Result.isFailure(decoded)) {
				yield* Console.error(
					`fabrika eval: ${opts.path} is not a valid ruled-KEEP enumeration (${decoded.failure.reason}): ${decoded.failure.message}`,
				);
				return yield* Effect.sync(() => process.exit(MALFORMED_DOCUMENT));
			}
			const violations = ruledKeepsViolations(decoded.success);
			if (violations.length > 0) {
				yield* Console.error(
					`fabrika eval: ${opts.path} decodes but breaks its own integrity rules:\n${violations.map((v) => `  - ${v}`).join("\n")}`,
				);
				return yield* Effect.sync(() => process.exit(INTEGRITY_VIOLATION));
			}

			const ledgerPath =
				opts.provenance._tag === "Some"
					? opts.provenance.value
					: path.join(path.dirname(opts.path), "provenance.json");
			const ledgerText = yield* Effect.mapError(
				fs.readFileString(ledgerPath),
				() => new KeepsUnreadable({path: ledgerPath}),
			);
			const ledger = decodeIncidentProvenance(ledgerText);
			if (Result.isFailure(ledger)) {
				yield* Console.error(
					`fabrika eval: ${ledgerPath} is not a valid provenance ledger (${ledger.failure.reason}): ${ledger.failure.message}`,
				);
				return yield* Effect.sync(() => process.exit(MALFORMED_DOCUMENT));
			}

			const covered = withCoverage(decoded.success, ledger.success);
			yield* Console.log(
				opts.json ? keepsToJson(decoded.success, covered) : renderKeeps(decoded.success, covered),
			);
		});
		yield* run.pipe(
			Effect.catchTag("KeepsUnreadable", (e) =>
				Effect.gen(function* () {
					yield* Console.error(`fabrika eval: cannot read ${e.path}`);
					return yield* Effect.sync(() => process.exit(FAILED));
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Print the ruled KEEP corpus of eval feedstock."),
	Command.withDescription(
		"Print the ruled KEEP corpus — the committed enumeration of the fabrika eval feedstock, with each row's derivation and the eval cases that pin it (#4823)",
	),
);

// A named cost-baseline input that could not be read — a hard error (exit 1), not a skip.
class BaselineInputUnreadable extends Schema.TaggedErrorClass<BaselineInputUnreadable>()(
	"BaselineInputUnreadable",
	{path: Schema.String},
) {}

const ledgerFlag = Flag.string("ledger").pipe(
	Flag.withDescription(
		"path to the spend ledger (JSONL) whose rows are folded — the durable file `eval run --spend-ledger` appends to",
	),
);

const ledgerArmFlag = Flag.string("arm").pipe(
	Flag.withDefault("with-skill"),
	Flag.withDescription(
		`which arm's rows to fold (${EVAL_ARMS.join(", ")}); the v1 baseline is the with-skill arm run against the v1 plugin dir`,
	),
);

const ledgerSkillFlag = Flag.string("skill").pipe(
	Flag.optional,
	Flag.withDescription(
		"fold only rows recorded under this skill name (default: every row in scope)",
	),
);

/** Rows a baseline or candidate fold is taken over — the arm, and optionally the skill, the caller named. */
const selectRows = (
	rows: ReadonlyArray<LedgerRow>,
	arm: string,
	skill: string | null,
): ReadonlyArray<LedgerRow> =>
	rows.filter((row) => row.arm === arm && (skill === null || row.skillName === skill));

const readLedgerRows = Effect.fn(function* (path: string, arm: string, skill: string | null) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* Effect.mapError(
		fs.readFileString(path),
		() => new BaselineInputUnreadable({path}),
	);
	const read = readSpendLedger(text);
	// The unread lines are reported rather than folded into "no rows": a total that silently omits
	// damaged lines is wrong and looks right, which is the whole discipline of `spend/rollup.ts`.
	if (read.skipped > 0) {
		yield* Console.error(
			`fabrika eval: ${path} — ${read.skipped} line(s) unread (${read.skips.malformed} malformed, ${read.skips.newerVersion} newer-version); they are absent from every figure below`,
		);
	}
	return selectRows(read.rows, arm, skill);
});

const suiteFlag = Flag.string("suite").pipe(
	Flag.withDefault("v1"),
	Flag.withDescription("which suite was measured — the baseline arm of the published SOTA proof"),
);

const corpusFlag = Flag.string("corpus").pipe(
	Flag.withDescription(
		"path to the ruled-KEEP enumeration (incident-corpus/ruled-keeps.json) — its member/pending counts are read, never asserted",
	),
);

const corpusRevisionFlag = Flag.string("corpus-revision").pipe(
	Flag.withDescription("the commit the corpus files were read at — the pin AC2 requires"),
);

const casesFlag = Flag.string("cases").pipe(
	Flag.withDescription(
		"path to the authored eval set that was executed (incident-corpus/evals.json)",
	),
);

const baselinePluginDirFlag = Flag.string("plugin-dir").pipe(
	Flag.withDescription(
		"the repo-relative plugin dir the measured arm loaded — the adapter AC5 asks the artifact to record",
	),
);

const harnessRevisionFlag = Flag.string("harness-revision").pipe(
	Flag.withDescription(
		"the commit the harness ran from — the harness version pin (a commit pins it exactly; the package semver has never moved)",
	),
);

const recordedAtFlag = Flag.string("recorded-at").pipe(
	Flag.optional,
	Flag.withDescription("ISO-8601 UTC stamp for the artifact (default: now)"),
);

const baselineOutFlag = Flag.string("out").pipe(
	Flag.optional,
	Flag.withDescription(
		"write the baseline JSON here — the committed series lives under claude-plugins/fabrika/reports/eval/",
	),
);

/**
 * `baseline record` — fold a v1 run's spend rows into the committed, dated cost baseline (#4679).
 *
 * Every figure comes from rows `token-spend` already reconstructed; the verb adds no meter. The pins
 * it cannot derive are flags, and the two it can — model and CLI version — are read off the rows, so
 * a baseline cannot claim a model its runs did not use.
 */
const baselineRecord = leafCommand(
	"record",
	{
		ledger: ledgerFlag,
		arm: ledgerArmFlag,
		skill: ledgerSkillFlag,
		suite: suiteFlag,
		corpus: corpusFlag,
		corpusRevision: corpusRevisionFlag,
		cases: casesFlag,
		pluginDir: baselinePluginDirFlag,
		harnessRevision: harnessRevisionFlag,
		recordedAt: recordedAtFlag,
		out: baselineOutFlag,
		json: jsonFlag,
	},
	Effect.fn(function* (opts) {
		const run = Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;

			const corpusText = yield* Effect.mapError(
				fs.readFileString(opts.corpus),
				() => new BaselineInputUnreadable({path: opts.corpus}),
			);
			const keepsFile = decodeRuledKeeps(corpusText);
			if (Result.isFailure(keepsFile)) {
				yield* Console.error(
					`fabrika eval: ${opts.corpus} is not a valid ruled-KEEP enumeration (${keepsFile.failure.reason}): ${keepsFile.failure.message}`,
				);
				return yield* Effect.sync(() => process.exit(MALFORMED_DOCUMENT));
			}

			const casesText = yield* Effect.mapError(
				fs.readFileString(opts.cases),
				() => new BaselineInputUnreadable({path: opts.cases}),
			);
			const set = decodeSkillEvalSet(casesText);
			if (Result.isFailure(set)) {
				yield* Console.error(
					`fabrika eval: ${opts.cases} is not a valid skill eval set (${set.failure.reason}): ${set.failure.message}`,
				);
				return yield* Effect.sync(() => process.exit(MALFORMED_DOCUMENT));
			}

			const rows = yield* readLedgerRows(
				opts.ledger,
				opts.arm,
				opts.skill._tag === "Some" ? opts.skill.value : null,
			);
			const built = buildCostBaseline({
				rows,
				pins: {
					suite: opts.suite,
					recordedAt:
						opts.recordedAt._tag === "Some" ? opts.recordedAt.value : new Date().toISOString(),
					corpus: {
						path: opts.corpus,
						revision: opts.corpusRevision,
						members: keepsFile.success.rows.filter((row) => row.status === "member").length,
						pending: keepsFile.success.rows.filter((row) => row.status === "pending").length,
						cases: set.success.cases.length,
					},
					harness: {
						runner: "fabrika eval run",
						pluginDir: opts.pluginDir,
						arm: opts.arm,
						revision: opts.harnessRevision,
					},
				},
			});
			if (Result.isFailure(built)) {
				yield* Console.error(`fabrika eval: ${built.failure.reason}: ${built.failure.message}`);
				return yield* Effect.sync(() =>
					process.exit(built.failure.reason === "no-rows" ? ZERO_SCOPE : MALFORMED_DOCUMENT),
				);
			}

			const baseline = built.success;
			if (opts.out._tag === "Some") {
				yield* fs.writeFileString(opts.out.value, costBaselineToJson(baseline));
			}
			yield* Console.log(opts.json ? costBaselineToJson(baseline) : renderCostBaseline(baseline));
		});
		yield* run.pipe(
			Effect.catchTag("BaselineInputUnreadable", (e) =>
				Effect.gen(function* () {
					yield* Console.error(`fabrika eval: cannot read ${e.path}`);
					return yield* Effect.sync(() => process.exit(FAILED));
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Record the dated v1 cost baseline from measured spend rows."),
	Command.withDescription(
		"Fold a measured run's spend-ledger rows into the committed, dated cost baseline — pinned to corpus revision, run count, model, CLI and harness version (#4679)",
	),
);

const baselineArg = Argument.string("baseline").pipe(
	Argument.withDescription("path to a committed cost baseline JSON file"),
);

/**
 * `baseline compare` — the mechanical phase-1 answer: is this spend at or below the v1 baseline?
 *
 * The exit code is the answer, so a caller never has to parse prose: `0` at-or-below,
 * `ABOVE_BASELINE` above, `BASELINE_INCOMPARABLE` when the two sides did not price the same work.
 * The third seat is what keeps "could not compare" from ever reading as a pass.
 */
const baselineCompare = leafCommand(
	"compare",
	{
		baseline: baselineArg,
		ledger: ledgerFlag,
		arm: ledgerArmFlag,
		skill: ledgerSkillFlag,
		json: jsonFlag,
	},
	Effect.fn(function* (opts) {
		const run = Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const text = yield* Effect.mapError(
				fs.readFileString(opts.baseline),
				() => new BaselineInputUnreadable({path: opts.baseline}),
			);
			const decoded = decodeCostBaseline(text);
			if (Result.isFailure(decoded)) {
				yield* Console.error(
					`fabrika eval: ${opts.baseline} is not a valid cost baseline (${decoded.failure.reason}): ${decoded.failure.message}`,
				);
				return yield* Effect.sync(() => process.exit(MALFORMED_DOCUMENT));
			}

			const rows = yield* readLedgerRows(
				opts.ledger,
				opts.arm,
				opts.skill._tag === "Some" ? opts.skill.value : null,
			);
			const fold = foldLedgerRows(rows);
			// A candidate that cannot be folded is INCOMPARABLE, not a failure to invoke: the baseline
			// was read and the question was asked, and the honest answer is that no ceiling verdict
			// exists over these rows.
			if (Result.isFailure(fold)) {
				yield* Console.error(`fabrika eval: INCOMPARABLE — ${fold.failure.message}`);
				return yield* Effect.sync(() => process.exit(BASELINE_INCOMPARABLE));
			}

			const comparison = compareToBaseline(decoded.success, fold.success);
			yield* Console.log(
				opts.json
					? `${JSON.stringify(comparison, null, 2)}\n`
					: renderBaselineComparison(comparison),
			);
			if (comparison.verdict === "at-or-below") return;
			return yield* Effect.sync(() =>
				process.exit(comparison.verdict === "above" ? ABOVE_BASELINE : BASELINE_INCOMPARABLE),
			);
		});
		yield* run.pipe(
			Effect.catchTag("BaselineInputUnreadable", (e) =>
				Effect.gen(function* () {
					yield* Console.error(`fabrika eval: cannot read ${e.path}`);
					return yield* Effect.sync(() => process.exit(FAILED));
				}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Answer whether spend is at or below the v1 cost baseline."),
	Command.withDescription(
		"Compare measured spend against a committed cost baseline over the same corpus — exit 0 at-or-below, 15 above, 16 incomparable (#4679)",
	),
);

const baseline = Command.make("baseline").pipe(
	Command.withSubcommands([baselineRecord, baselineCompare]),
	Command.withDescription(
		"The v1 cost baseline on the incident corpus and the phase-1 ceiling comparison against it (#4679)",
	),
);

export const evalCommand = Command.make("eval").pipe(
	Command.withSubcommands([check, report, cases, runCommand, graded, keeps, baseline]),
	Command.withDescription(
		"Graded per-stage corpus + scorecard + authored-eval-set ingestion + the unattended runner + the five-run graded axis + the ruled KEEP enumeration + the v1 cost baseline (#1848, #1853, #4674, #4676, #4678, #4823, #4679)",
	),
);
