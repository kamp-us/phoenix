import {assert, describe, it} from "@effect/vitest";
import {Result} from "effect";
import type {CorpusEntry, CorpusManifest} from "./corpus.ts";
import {
	type CaptureManifest,
	collectFromCapture,
	collectRuns,
	decodeCaptureManifest,
	type RunInput,
	type RunRow,
	type RunSpend,
} from "./runner.ts";

// One assistant-message transcript line — the shape `token-spend` reconstructs spend from. `billed`
// = input + cache_creation + cache_read + output = 10 + 5 + 100 + 20 = 135.
const transcript = (
	input: number,
	cacheCreate: number,
	cacheRead: number,
	output: number,
	model = "claude-test",
): string =>
	JSON.stringify({
		message: {
			role: "assistant",
			model,
			usage: {
				input_tokens: input,
				cache_creation_input_tokens: cacheCreate,
				cache_read_input_tokens: cacheRead,
				output_tokens: output,
			},
		},
	});

// Two triage corpus entries — the ground-truth labels the runner grades actual artifacts against.
const entryA: CorpusEntry = {
	stage: "triage",
	inputRef: 100,
	label: {type: "bug", priority: "p0", status: "triaged"},
};
const entryB: CorpusEntry = {
	stage: "triage",
	inputRef: 200,
	label: {type: "chore", priority: "p2", status: "triaged"},
};

const isReconstructed = (s: RunSpend): s is Extract<RunSpend, {_tag: "Reconstructed"}> =>
	s._tag === "Reconstructed";
const isFail = (r: RunRow): boolean => r.grade.status === "fail";

describe("collectRuns — offline/replay over supplied transcripts + artifacts (story 6)", () => {
	it("a full-pass corpus: every entry grades pass, spend reconstructed via token-spend", () => {
		const inputs: ReadonlyArray<RunInput> = [
			{entry: entryA, transcript: transcript(10, 5, 100, 20), artifact: entryA.label},
			{entry: entryB, transcript: transcript(1, 2, 3, 4), artifact: entryB.label},
		];
		const rows = collectRuns(inputs);
		assert.strictEqual(rows.length, 2);
		assert.isTrue(rows.every((r) => r.grade.status === "pass"));
		assert.isTrue(rows.every((r) => r.spend._tag === "Reconstructed"));
		const [rowA, rowB] = rows;
		if (rowA !== undefined && isReconstructed(rowA.spend)) {
			assert.strictEqual(rowA.spend.spend.billed, 135);
			assert.strictEqual(rowA.spend.spend.model, "claude-test");
		} else {
			assert.fail("expected rowA spend reconstructed");
		}
		if (rowB !== undefined && isReconstructed(rowB.spend)) {
			assert.strictEqual(rowB.spend.spend.billed, 10);
		} else {
			assert.fail("expected rowB spend reconstructed");
		}
	});

	it("a mixed pass/fail corpus: a divergent artifact grades fail, the matching one passes; both counted", () => {
		const inputs: ReadonlyArray<RunInput> = [
			{entry: entryA, transcript: transcript(10, 5, 100, 20), artifact: entryA.label}, // pass
			{
				entry: entryB,
				transcript: transcript(10, 5, 100, 20),
				artifact: {type: "feature", priority: "p2", status: "triaged"}, // type diverges → fail
			},
		];
		const rows = collectRuns(inputs);
		assert.strictEqual(rows.length, 2);
		assert.strictEqual(rows[0]?.grade.status, "pass");
		assert.strictEqual(rows[1]?.grade.status, "fail");
		// the fail carries the attributable field mismatch (never a bare boolean)
		const failRow = rows[1];
		if (failRow !== undefined && failRow.grade.status === "fail") {
			assert.strictEqual(failRow.grade.mismatch._tag, "LabelMismatch");
			if (failRow.grade.mismatch._tag === "LabelMismatch") {
				assert.deepStrictEqual(failRow.grade.mismatch.fields, [
					{field: "type", observed: "feature", expected: "chore"},
				]);
			}
		}
		// both runs still have reconstructed spend — a fail is graded, not dropped
		assert.isTrue(rows.every((r) => isReconstructed(r.spend)));
	});

	it("a missing-transcript entry is graded and counted with TranscriptMissing spend, never a crash", () => {
		const inputs: ReadonlyArray<RunInput> = [
			{entry: entryA, transcript: null, artifact: entryA.label}, // transcript absent
			{entry: entryB, transcript: transcript(1, 1, 1, 1), artifact: entryB.label},
		];
		const rows = collectRuns(inputs);
		assert.strictEqual(rows.length, 2);
		// the missing-transcript run is still graded against its label…
		assert.strictEqual(rows[0]?.grade.status, "pass");
		// …but its spend is the explicit TranscriptMissing sentinel, not a fabricated zero
		assert.strictEqual(rows[0]?.spend._tag, "TranscriptMissing");
		assert.strictEqual(rows[1]?.spend._tag, "Reconstructed");
	});

	it("a missing transcript AND a divergent artifact: fail-graded, still counted, no crash", () => {
		const rows = collectRuns([
			{
				entry: entryA,
				transcript: null,
				artifact: {type: "chore", priority: "p0", status: "triaged"}, // type diverges → fail
			},
		]);
		assert.strictEqual(rows.length, 1);
		assert.isTrue(isFail(rows[0] as RunRow));
		assert.strictEqual(rows[0]?.spend._tag, "TranscriptMissing");
	});
});

// A corpus carrying the two triage ground-truth entries (other stages empty).
const corpus: CorpusManifest = {
	version: 1,
	stages: {
		triage: [entryA, entryB],
		"write-code": [],
		"review-code": [],
		"review-doc": [],
		"ship-it": [],
	},
};

describe("collectFromCapture — capture-manifest fold against the corpus (story 7)", () => {
	it("joins each capture run to its corpus entry by (stage, inputRef), loading transcripts by path", () => {
		const capture: CaptureManifest = {
			version: 1,
			runs: [
				{
					stage: "triage",
					inputRef: 100,
					transcriptPath: "session-x/subagents/agent-a.jsonl",
					artifact: entryA.label,
				},
				{
					stage: "triage",
					inputRef: 200,
					transcriptPath: "session-x/subagents/agent-b.jsonl",
					artifact: {type: "feature", priority: "p2", status: "triaged"}, // diverges → fail
				},
			],
		};
		const transcripts: Record<string, string> = {
			"session-x/subagents/agent-a.jsonl": transcript(10, 5, 100, 20),
			"session-x/subagents/agent-b.jsonl": transcript(2, 2, 2, 2),
		};
		const rows = collectFromCapture({
			stage: "triage",
			corpus,
			capture,
			loadTranscript: (p) => transcripts[p] ?? null,
		});
		assert.strictEqual(rows.length, 2);
		assert.strictEqual(rows[0]?.grade.status, "pass");
		assert.strictEqual(rows[1]?.grade.status, "fail");
		assert.strictEqual(rows[0]?.spend._tag, "Reconstructed");
	});

	it("a capture run whose transcript the loader can't find folds in with TranscriptMissing", () => {
		const capture: CaptureManifest = {
			version: 1,
			runs: [
				{
					stage: "triage",
					inputRef: 100,
					transcriptPath: "gone.jsonl",
					artifact: entryA.label,
				},
			],
		};
		const rows = collectFromCapture({
			stage: "triage",
			corpus,
			capture,
			loadTranscript: () => null, // nothing on disk
		});
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0]?.grade.status, "pass");
		assert.strictEqual(rows[0]?.spend._tag, "TranscriptMissing");
	});

	it("skips a capture run with no matching corpus entry (no ground-truth label to grade against)", () => {
		const capture: CaptureManifest = {
			version: 1,
			runs: [
				{stage: "triage", inputRef: 999, transcriptPath: "x.jsonl", artifact: {}}, // no entry #999
			],
		};
		const rows = collectFromCapture({
			stage: "triage",
			corpus,
			capture,
			loadTranscript: () => transcript(1, 1, 1, 1),
		});
		assert.strictEqual(rows.length, 0);
	});
});

describe("decodeCaptureManifest — total on malformed input (never throws)", () => {
	it("decodes a well-formed capture manifest", () => {
		const text = JSON.stringify({
			version: 1,
			runs: [{stage: "triage", inputRef: 100, transcriptPath: "a.jsonl", artifact: {any: "shape"}}],
		});
		const result = decodeCaptureManifest(text);
		assert.isTrue(Result.isSuccess(result));
		if (Result.isSuccess(result)) {
			assert.strictEqual(result.success.runs.length, 1);
		}
	});

	it("returns a typed malformed-json failure on a non-JSON body", () => {
		const result = decodeCaptureManifest("not json {");
		assert.isTrue(Result.isFailure(result));
		if (Result.isFailure(result)) {
			assert.strictEqual(result.failure._tag, "CaptureDecodeError");
			assert.strictEqual(result.failure.reason, "malformed-json");
		}
	});

	it("returns a typed schema-mismatch failure on well-formed JSON of the wrong shape", () => {
		const result = decodeCaptureManifest(JSON.stringify({version: 1, runs: [{stage: "deploy"}]}));
		assert.isTrue(Result.isFailure(result));
		if (Result.isFailure(result)) {
			assert.strictEqual(result.failure._tag, "CaptureDecodeError");
			assert.strictEqual(result.failure.reason, "schema-mismatch");
		}
	});
});
