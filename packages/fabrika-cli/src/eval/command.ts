/**
 * The `eval` verb group — `fabrika eval check|report|cases|run|keeps`.
 *
 * The graded-corpus apparatus for adjudicating a stochastic model swap per stage (epic
 * #1842), plus the ingestion of `/skill-creator`-authored eval sets (epic #4649). Five live
 * surfaces:
 *
 *   fabrika eval check <manifest>   # decode a corpus manifest; exit non-zero on a bad one
 *   fabrika eval report <rows>      # the graded two-axis scorecard over runner rows
 *   fabrika eval cases <path>       # decode an authored eval set; exit non-zero on a bad one
 *   fabrika eval run <path>         # execute an eval set unattended, emit the capture manifest
 *   fabrika eval keeps <path>       # print the ruled KEEP corpus and what already pins each row
 *
 * `check` (issue #1848) validates the on-disk corpus format. `report` (issue #1853) is the
 * top of the vertical slice: it reads the runner's graded `{entry, grade, spend}` rows and
 * renders the per-(stage × model) scorecard — pass-rate + per-run token spend + repair-churn
 * cost — as a human table (default) or stable JSON (`--json`), the evidence the model-tiering
 * decision (#1576) consumes. It presents measurement, never a recommendation. `cases` (issue
 * #4674) validates a `/skill-creator` `evals/evals.json` and prints the tier each case derives to.
 * `keeps` (issue #4823) prints the ruled KEEP corpus — the enumeration that replaced the
 * two-artifact join every consumer used to re-run by hand.
 *
 * Thin IO shell over the pure cores (the `token-spend` / `readme-guard` idiom): read the file,
 * decode, render. An unreadable path and a malformed/mismatched input both exit non-zero.
 */
import {Console, Crypto, Effect, FileSystem, Path, Result} from "effect";
import * as Schema from "effect/Schema";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import {DEFAULT_SPEND_LEDGER_PATH, persistSpendRows} from "../spend/ledger.ts";
import {decodeManifest, REVIEW_SURFACES, type ReviewSurface, STAGES} from "./corpus.ts";
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
				return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
			}
			yield* Console.log(`fabrika eval: ${manifest} is a valid corpus manifest.`);
		});
		yield* run.pipe(
			Effect.catchTag("ManifestUnreadable", (e) =>
				Effect.gen(function* () {
					yield* Console.error(`fabrika eval: cannot read manifest ${e.path}`);
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
				return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
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
					return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
				}
				if (baselineSurface._tag === "Some" && stage !== "review") {
					yield* Console.error(
						`fabrika eval: --baseline-surface only applies to --baseline-stage review, not '${stage}'`,
					);
					return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
				}
				if (stage === "review" && baselineSurface._tag === "None") {
					yield* Console.error(
						`fabrika eval: --baseline-stage review needs --baseline-surface (${REVIEW_SURFACES.join(", ")}) — a review pass-rate is one grading regime, never an average of two`,
					);
					return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
				}
				const model = baselineModel._tag === "Some" ? baselineModel.value : null;
				if (baselineSurface._tag === "Some") {
					const surface = baselineSurface.value;
					if (!isReviewSurface(surface)) {
						yield* Console.error(
							`fabrika eval: --baseline-surface '${surface}' is not a known review surface (${REVIEW_SURFACES.join(", ")})`,
						);
						return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
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
				return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
			}
			const set = result.success;
			// A schema-valid set with zero cases would report green while checking nothing — the
			// zero-scope pass ADR 0092 forbids. It reds with a named reason like any other bad set.
			if (set.cases.length === 0) {
				yield* Console.error(
					`fabrika eval: ${path} is not a usable skill eval set (empty-set): it decodes, but carries zero eval cases (ADR 0092 — zero scope reds)`,
				);
				return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
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
				return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
			}
			const set = decoded.success;
			if (set.cases.length === 0) {
				yield* Console.error(
					`fabrika eval: ${opts.path} carries zero eval cases — refusing to report a green suite that ran nothing (ADR 0092)`,
				);
				return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
			}
			if (!isStageName(opts.stage)) {
				yield* Console.error(
					`fabrika eval: --stage '${opts.stage}' is not a known stage (${STAGES.join(", ")})`,
				);
				return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
			}
			const arms = parseArms(opts.arms);
			if (arms === null) {
				yield* Console.error(
					`fabrika eval: --arms '${opts.arms}' names something that is not an arm (${EVAL_ARMS.join(", ")})`,
				);
				return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
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
				return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
			}
		});
		yield* run.pipe(
			Effect.catchTag("EvalSetUnreadable", (e) =>
				Effect.gen(function* () {
					yield* Console.error(`fabrika eval: cannot read ${e.path}`);
					return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
				}),
			),
		);
	}),
).pipe(
	Command.withDescription(
		"Execute a skill's eval set unattended (both arms) and emit the capture manifest the existing collector consumes — for an operator's shell or a review-skill spawn, never a CI job (#4676)",
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
				return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
			}
			const violations = ruledKeepsViolations(decoded.success);
			if (violations.length > 0) {
				yield* Console.error(
					`fabrika eval: ${opts.path} decodes but breaks its own integrity rules:\n${violations.map((v) => `  - ${v}`).join("\n")}`,
				);
				return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
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
				return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
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
					return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
				}),
			),
		);
	}),
).pipe(
	Command.withDescription(
		"Print the ruled KEEP corpus — the committed enumeration of the fabrika eval feedstock, with each row's derivation and the eval cases that pin it (#4823)",
	),
);

export const evalCommand = Command.make("eval").pipe(
	Command.withSubcommands([check, report, cases, runCommand, keeps]),
	Command.withDescription(
		"Graded per-stage corpus + scorecard + authored-eval-set ingestion + the unattended runner + the ruled KEEP enumeration (#1848, #1853, #4674, #4676, #4823)",
	),
);
