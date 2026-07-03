import {assert, describe, it} from "@effect/vitest";
import {Result} from "effect";
import * as Schema from "effect/Schema";
import {
	CorpusEntry,
	type CorpusManifest,
	decodeManifest,
	encodeManifest,
	STAGES,
} from "./corpus.ts";

const decodeEntry = Schema.decodeUnknownResult(CorpusEntry);

/** A valid manifest carrying exactly one known-good entry for every stage. */
const validManifest = {
	version: 1,
	stages: {
		triage: [
			{stage: "triage", inputRef: 1848, label: {type: "chore", priority: "p1", status: "triaged"}},
		],
		"write-code": [
			{
				stage: "write-code",
				inputRef: 1848,
				label: {fixesRef: 1848, ciGreen: true, reviewVerdict: "PASS"},
			},
		],
		"review-code": [
			{stage: "review-code", inputRef: 1849, label: {verdict: "PASS", acFindings: ["AC1 met"]}},
		],
		"review-doc": [
			{stage: "review-doc", inputRef: 1850, label: {verdict: "FAIL", findings: ["broken link"]}},
		],
		"ship-it": [{stage: "ship-it", inputRef: 1851, label: {merged: true, mergeSha: "deadbee"}}],
	},
} satisfies CorpusManifest;

describe("decodeManifest — a valid manifest per stage round-trips", () => {
	it("decodes a manifest with one entry per stage", () => {
		const result = decodeManifest(JSON.stringify(validManifest));
		assert.isTrue(Result.isSuccess(result));
		if (Result.isSuccess(result)) {
			assert.strictEqual(result.success.version, 1);
			for (const stage of STAGES) {
				assert.strictEqual(result.success.stages[stage].length, 1);
			}
		}
	});

	it("round-trips: encodeManifest → decodeManifest yields the same manifest", () => {
		const encoded = encodeManifest(validManifest);
		const result = decodeManifest(encoded);
		assert.isTrue(Result.isSuccess(result));
		if (Result.isSuccess(result)) {
			assert.deepStrictEqual(result.success, validManifest);
		}
	});
});

describe("CorpusEntry — an unknown stage is rejected", () => {
	it("rejects an entry whose stage is not one of the five", () => {
		const result = decodeEntry({stage: "deploy", inputRef: 1, label: {}});
		assert.isTrue(Result.isFailure(result));
	});

	it("rejects a manifest whose entry carries an unknown stage discriminator", () => {
		const bad = {
			...validManifest,
			stages: {
				...validManifest.stages,
				triage: [
					{stage: "deploy", inputRef: 1, label: {type: "chore", priority: "p1", status: "x"}},
				],
			},
		};
		const result = decodeManifest(JSON.stringify(bad));
		assert.isTrue(Result.isFailure(result));
	});
});

describe("CorpusEntry — a per-stage label-shape mismatch is rejected", () => {
	it("rejects a write-code stage carrying a triage-shaped label", () => {
		const result = decodeEntry({
			stage: "write-code",
			inputRef: 1848,
			label: {type: "chore", priority: "p1", status: "triaged"},
		});
		assert.isTrue(Result.isFailure(result));
	});

	it("rejects a triage stage carrying a write-code-shaped label", () => {
		const result = decodeEntry({
			stage: "triage",
			inputRef: 1848,
			label: {fixesRef: 1848, ciGreen: true, reviewVerdict: "PASS"},
		});
		assert.isTrue(Result.isFailure(result));
	});

	it("rejects an out-of-range verdict literal in a review-code label", () => {
		const result = decodeEntry({
			stage: "review-code",
			inputRef: 1849,
			label: {verdict: "MAYBE", acFindings: []},
		});
		assert.isTrue(Result.isFailure(result));
	});
});

describe("decodeManifest — total on malformed input (never throws)", () => {
	it("returns a typed malformed-json failure on a non-JSON body", () => {
		const result = decodeManifest("not json at all {");
		assert.isTrue(Result.isFailure(result));
		if (Result.isFailure(result)) {
			assert.strictEqual(result.failure._tag, "ManifestDecodeError");
			assert.strictEqual(result.failure.reason, "malformed-json");
		}
	});

	it("returns a typed schema-mismatch failure on well-formed JSON of the wrong shape", () => {
		const result = decodeManifest(JSON.stringify({version: "one", stages: {}}));
		assert.isTrue(Result.isFailure(result));
		if (Result.isFailure(result)) {
			assert.strictEqual(result.failure._tag, "ManifestDecodeError");
			assert.strictEqual(result.failure.reason, "schema-mismatch");
		}
	});
});
