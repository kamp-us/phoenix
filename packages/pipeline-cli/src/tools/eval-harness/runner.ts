/**
 * eval-harness corpus runner — collect graded runs for one (stage × model), offline (issue
 * #1851, epic #1842).
 *
 * The collection layer between the corpus format (#1848) and the report slice (#1853): for
 * each corpus entry it grades the entry's actual run `artifact` (via `oracle.ts` `gradeEntry`)
 * and reconstructs the run's token spend from its sub-agent transcript (via the `token-spend`
 * core, ADR 0112 §2), yielding a `{entry, grade, spend}` row. A per-(stage × model) collection
 * of those rows is the raw material the report slice aggregates into pass-rate + churn cost.
 *
 * This runner is a deterministic, side-effect-light COLLECTOR over runs that already happened —
 * it does NOT spawn stage agents (spawning is the operator's act; the fleet model is pinned by
 * spawn-guard). Two modes, story-split:
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
import {Result} from "effect";
import * as Schema from "effect/Schema";
import {reconstructSpend, type StageSpend} from "../token-spend/token-spend.ts";
import {type CorpusEntry, type CorpusManifest, STAGES} from "./corpus.ts";
import {type Grade, gradeEntry} from "./oracle.ts";

/**
 * One run's token spend: reconstructed from its transcript, or explicitly missing. Modelled as a
 * union (not a nullable `StageSpend`) so a not-found transcript is a distinct, counted outcome —
 * never a fabricated zero the report could mistake for a genuinely free run.
 */
export type RunSpend =
	| {readonly _tag: "Reconstructed"; readonly spend: StageSpend}
	| {readonly _tag: "TranscriptMissing"};

/** One graded run row: the corpus entry, its grade against the label, and its token spend. */
export interface RunRow {
	readonly entry: CorpusEntry;
	readonly grade: Grade;
	readonly spend: RunSpend;
}

/**
 * One offline run input: a corpus entry paired with its captured transcript text + recorded
 * artifact. `transcript === null` means the transcript was not found — the run is still graded
 * against its label and counted (with `TranscriptMissing` spend), never dropped or crashed.
 */
export interface RunInput {
	readonly entry: CorpusEntry;
	readonly transcript: string | null;
	readonly artifact: unknown;
}

/**
 * Collect one run: grade the artifact against the entry's label, and reconstruct spend from the
 * transcript (or mark it missing). Pure + total — a null/malformed transcript or artifact never
 * throws (spend reconstruction is fail-open per `token-spend`; grading is total per `oracle`).
 */
export const collectRun = (input: RunInput): RunRow => ({
	entry: input.entry,
	grade: gradeEntry(input.entry, input.artifact),
	spend:
		input.transcript === null
			? {_tag: "TranscriptMissing"}
			: {_tag: "Reconstructed", spend: reconstructSpend(input.transcript)},
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
 * label. `transcriptPath` is the sub-agent transcript at `<parent-session-id>/subagents/agent-<id>.jsonl`
 * (ADR 0112 §2); `artifact` is the recorded decision artifact graded as-is. This is the documented
 * shape a fresh live run (spawned by the operator, not this tool) folds into the corpus deterministically.
 */
export const CaptureRun = Schema.Struct({
	stage: Schema.Literals([...STAGES]),
	inputRef: Schema.Int,
	transcriptPath: Schema.String,
	artifact: Schema.Unknown,
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
 * stays pure by taking this as a parameter — the command shell (or the report slice) supplies an
 * fs-backed loader, and a not-found transcript surfaces as a `TranscriptMissing` run, never a throw.
 */
export type TranscriptLoader = (path: string) => string | null;

/**
 * Fold a capture manifest against the corpus ground truth for one stage, then collect graded rows
 * (story 7 → story 6). Each capture run joins to its `CorpusEntry` by (stage, inputRef) for the
 * label; a run whose (stage, inputRef) has no matching corpus entry is skipped (no label to grade
 * against), and a run whose transcript the loader can't find is collected with `TranscriptMissing`.
 */
export const collectFromCapture = (args: {
	readonly stage: CorpusEntry["stage"];
	readonly corpus: CorpusManifest;
	readonly capture: CaptureManifest;
	readonly loadTranscript: TranscriptLoader;
}): ReadonlyArray<RunRow> => {
	const entries: ReadonlyArray<CorpusEntry> = args.corpus.stages[args.stage];
	const byRef = new Map(entries.map((entry) => [entry.inputRef, entry] as const));
	const inputs: Array<RunInput> = [];
	for (const run of args.capture.runs) {
		if (run.stage !== args.stage) continue;
		const entry = byRef.get(run.inputRef);
		if (entry === undefined) continue;
		inputs.push({
			entry,
			transcript: args.loadTranscript(run.transcriptPath),
			artifact: run.artifact,
		});
	}
	return collectRuns(inputs);
};
