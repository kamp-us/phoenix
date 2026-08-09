/**
 * The eval corpus runner — collect graded runs for one (stage × model), offline (issue
 * #1851, epic #1842).
 *
 * The collection layer between the corpus format (#1848) and the report slice (#1853): for
 * each corpus entry it grades the entry's actual run `artifact` (via `oracle.ts` `gradeEntry`)
 * and reconstructs the run's token spend from its sub-agent transcript (via the `token-spend`
 * core, ADR 0112 §2), yielding a `{entry, grade, spend}` row. A per-(stage × model) collection
 * of those rows is the raw material the report slice aggregates into pass-rate + churn cost.
 *
 * This runner is a deterministic, side-effect-light COLLECTOR over runs that already happened — it
 * spawns nothing, which is what keeps the offline replay reproducible. That is still true of this
 * file, but no longer of the module: `spawn.ts`/`spawn-io.ts` execute an eval set (ADR 0236).
 * Two modes, story-split:
 *  - Offline/replay (story 6): `collectRuns` over already-loaded transcripts + recorded
 *    artifacts — reproducible, no spawn. The primary path.
 *  - Capture-manifest (story 7): `CaptureManifest` documents, per run, the transcript path +
 *    the recorded artifact, so a fresh live run (spawned by the operator) folds into the corpus
 *    deterministically; `collectFromCapture` joins it against the corpus ground truth.
 *
 * Total by construction, matching the corpus/oracle discipline: a missing transcript grades +
 * counts the run with an explicit `TranscriptMissing` spend rather than crashing, and a
 * malformed artifact grades `fail` through the oracle — never a throw.
 */
import {Effect, Result} from "effect";
import * as Schema from "effect/Schema";
import {classifyRunSpend, type RunSpend} from "../spend/token-spend.ts";
import {type CorpusEntry, type CorpusManifest, type LiveStage, STAGES} from "./corpus.ts";
import {type Grade, gradeEntry} from "./oracle.ts";

/**
 * The with/without methodology's arm variable is **skill availability**, and `--plugin-dir` is the
 * toggle: it loads the skill under test for that session only. `--disable-slash-commands` is NOT a
 * usable toggle — measured against a loaded plugin it short-circuits to `num_turns: 0`, `$0`,
 * `"Unknown command: …"` and never reaches the model (#4673 §4).
 *
 * The vocabulary lives here, beside the `CaptureRun` schema that constrains it, so a manifest can
 * name an arm without the collector depending on the executor built on top of it. `spawn.ts`
 * re-exports it, so its consumers are unchanged.
 */
export const EVAL_ARMS = ["with-skill", "without-skill"] as const;

export type EvalArm = (typeof EVAL_ARMS)[number];

/**
 * What a recorded run says about itself: the model it was pinned to, and the arm it belongs to.
 *
 * Both are nullable because a run recorded before this provenance existed attests neither, and a
 * legacy row must keep collecting rather than fail (#4996). `null` means *unrecorded*, never
 * "no model" — the scorecard reads it as "fall back to the transcript", not as a value to bucket on.
 */
export interface RunProvenance {
	readonly model: string | null;
	readonly arm: EvalArm | null;
}

/** The provenance of a run that recorded none — a legacy row, or a hand-assembled replay input. */
export const NO_PROVENANCE: RunProvenance = {model: null, arm: null};

/**
 * One graded run row: the corpus entry, its grade against the label, its token spend, and the
 * provenance of the run that produced it.
 */
export interface RunRow {
	readonly entry: CorpusEntry;
	readonly grade: Grade;
	readonly spend: RunSpend;
	readonly provenance: RunProvenance;
}

/**
 * One offline run input: a corpus entry paired with its captured transcript text + recorded
 * artifact. `transcript === null` means the transcript was not found — the run is still graded
 * against its label and counted (with `TranscriptMissing` spend), never dropped or crashed.
 * An omitted `provenance` collects as `NO_PROVENANCE`.
 */
export interface RunInput {
	readonly entry: CorpusEntry;
	readonly transcript: string | null;
	readonly artifact: unknown;
	readonly provenance?: RunProvenance;
}

/**
 * Collect one run: grade the artifact against the entry's label, and reconstruct spend from the
 * transcript (or mark it missing). Pure + total — a null/malformed transcript or artifact never
 * throws (spend reconstruction is fail-open per `token-spend`; grading is total per `oracle`).
 */
export const collectRun = (input: RunInput): RunRow => ({
	entry: input.entry,
	grade: gradeEntry(input.entry, input.artifact),
	spend: classifyRunSpend(input.transcript),
	provenance: input.provenance ?? NO_PROVENANCE,
});

/**
 * Offline/replay entry point (story 6): collect a graded `{entry, grade, spend}` row per supplied
 * run over already-captured transcripts + recorded artifacts. No agent spawn — the reproducible
 * path a CI or a re-analysis uses.
 */
export const collectRuns = (inputs: ReadonlyArray<RunInput>): ReadonlyArray<RunRow> =>
	inputs.map(collectRun);

/**
 * A capture-manifest run (story 7): names, for one corpus run, WHERE its transcript lives and WHAT
 * artifact it produced, keyed by (stage, inputRef) so it joins to a `CorpusEntry`'s ground-truth
 * label. `artifact` is the recorded decision artifact graded as-is.
 *
 * `transcriptPath` takes either of the two real shapes: a Task-spawned sub-agent's
 * `<parent-session-id>/subagents/agent-<id>.jsonl` (ADR 0112 §2), or a headless `claude -p` run's
 * `<claude-data-root>/projects/<cwd-slug>/<session-id>.jsonl` — a top-level session, so NOT under
 * `subagents/`. Both reconstruct through the same `token-spend` core.
 *
 * `model` and `arm` carry the run's own provenance onto the manifest, so a graded row keeps it after
 * the ledger is gone (#4996). Both decode to `null` when the key is absent, which is what keeps
 * every already-written manifest readable — an absent key is *unrecorded*, never a claim.
 */
export const CaptureRun = Schema.Struct({
	stage: Schema.Literals([...STAGES]),
	inputRef: Schema.Int,
	transcriptPath: Schema.String,
	artifact: Schema.Unknown,
	model: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
	arm: Schema.NullOr(Schema.Literals([...EVAL_ARMS])).pipe(
		Schema.withDecodingDefault(Effect.succeed(null)),
	),
});

export type CaptureRun = typeof CaptureRun.Type;

/** The capture manifest: the set of runs to fold into the corpus for a collection pass. */
export const CaptureManifest = Schema.Struct({
	version: Schema.Int,
	runs: Schema.Array(CaptureRun),
});

export type CaptureManifest = typeof CaptureManifest.Type;

/** A typed capture-manifest decode failure — malformed JSON, or a shape that doesn't match the schema. */
export class CaptureDecodeError extends Schema.TaggedErrorClass<CaptureDecodeError>()(
	"CaptureDecodeError",
	{
		reason: Schema.Literals(["malformed-json", "schema-mismatch"]),
		message: Schema.String,
	},
) {}

const decodeUnknownCapture = Schema.decodeUnknownResult(CaptureManifest);

/**
 * Decode a capture manifest from its on-disk text. Total — a non-JSON body or a schema mismatch
 * both return a typed `Result` failure, never a throw (mirrors `decodeManifest` in `corpus.ts`).
 */
export const decodeCaptureManifest = (
	text: string,
): Result.Result<CaptureManifest, CaptureDecodeError> =>
	Result.try({
		try: (): unknown => JSON.parse(text),
		catch: (cause) =>
			new CaptureDecodeError({
				reason: "malformed-json",
				message: cause instanceof Error ? cause.message : String(cause),
			}),
	}).pipe(
		Result.flatMap((parsed) =>
			decodeUnknownCapture(parsed).pipe(
				Result.mapError(
					(error) => new CaptureDecodeError({reason: "schema-mismatch", message: error.message}),
				),
			),
		),
	);

/**
 * Load a transcript's raw text for a path, or `null` when it is absent/unreadable. The runner core
 * stays free of platform services by taking this as a parameter — the command shell supplies the
 * `FileSystem`-backed loader, and a not-found transcript surfaces as a `TranscriptMissing` run.
 */
export type TranscriptLoader<R = never> = (path: string) => Effect.Effect<string | null, never, R>;

/**
 * Fold a capture manifest against the corpus ground truth for one stage, then collect graded rows
 * (story 7 → story 6). Each capture run joins to its `CorpusEntry` by (stage, inputRef) for the
 * label; a run whose (stage, inputRef) has no matching corpus entry is skipped (no label to grade
 * against), and a run whose transcript the loader can't find is collected with `TranscriptMissing`.
 * The join key is the LIVE stage — a recorded row's own provenance key never participates in it.
 */
export const collectFromCapture = <R>(args: {
	readonly stage: LiveStage;
	readonly corpus: CorpusManifest;
	readonly capture: CaptureManifest;
	readonly loadTranscript: TranscriptLoader<R>;
}): Effect.Effect<ReadonlyArray<RunRow>, never, R> =>
	Effect.gen(function* () {
		const entries: ReadonlyArray<CorpusEntry> = args.corpus.stages[args.stage];
		const byRef = new Map(entries.map((entry) => [entry.inputRef, entry] as const));
		const inputs: Array<RunInput> = [];
		for (const run of args.capture.runs) {
			if (run.stage !== args.stage) continue;
			const entry = byRef.get(run.inputRef);
			if (entry === undefined) continue;
			inputs.push({
				entry,
				transcript: yield* args.loadTranscript(run.transcriptPath),
				artifact: run.artifact,
				provenance: {model: run.model, arm: run.arm},
			});
		}
		return collectRuns(inputs);
	});
