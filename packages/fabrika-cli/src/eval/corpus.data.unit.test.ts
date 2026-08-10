import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {Result} from "effect";
import {decodeManifest} from "./corpus.ts";

// The committed ground-truth corpus lives beside this test, one manifest per stage.
const CORPUS_DIR = fileURLToPath(new URL("./corpus", import.meta.url));

const manifestFiles = readdirSync(CORPUS_DIR)
	.filter((name) => name.endsWith(".json"))
	.sort();

const decodeFile = (name: string) =>
	decodeManifest(readFileSync(fileURLToPath(new URL(`./corpus/${name}`, import.meta.url)), "utf8"));

describe("committed corpus — every manifest decodes clean (a malformed corpus cannot land)", () => {
	it("finds the three per-stage manifests on disk", () => {
		assert.deepStrictEqual(manifestFiles, ["build.json", "review.json", "triage.json"]);
	});

	for (const name of manifestFiles) {
		it(`decodeManifest accepts ${name}`, () => {
			const result = decodeFile(name);
			assert.isTrue(Result.isSuccess(result), `${name} must decode to Ok`);
		});
	}
});

describe("committed corpus — meaningful pass-rate, not n=1 (seed + ≥2 per stage)", () => {
	// AC1: each stage manifest seeds the ADR 0112 §1 recorded input plus ≥2 more entries.
	const expected = [
		{file: "triage.json", stage: "triage", seed: 1227, min: 3},
		{file: "build.json", stage: "build", seed: 1223, min: 3},
		{file: "review.json", stage: "review", seed: 1199, min: 3},
	] as const;

	for (const {file, stage, seed, min} of expected) {
		it(`${file} carries ≥${min} ${stage} entries including the §1 seed #${seed}`, () => {
			const result = decodeFile(file);
			assert.isTrue(Result.isSuccess(result));
			if (Result.isSuccess(result)) {
				const entries = result.success.stages[stage];
				assert.isAtLeast(entries.length, min);
				assert.isTrue(
					entries.some((e) => e.inputRef === seed),
					`${stage} corpus must seed the ADR 0112 §1 recorded input #${seed}`,
				);
			}
		});
	}
});

describe("committed corpus — the recorded v1 rows keep their provenance (#4977 ruling)", () => {
	it("build.json's rows are still keyed write-code, not relabelled as fabrika baselines", () => {
		const result = decodeFile("build.json");
		assert.isTrue(Result.isSuccess(result));
		if (Result.isSuccess(result)) {
			const rows = result.success.stages.build;
			assert.isAtLeast(rows.length, 3);
			assert.deepStrictEqual(
				rows.map((row) => row.stage),
				["write-code", "write-code", "write-code"],
			);
		}
	});

	it("review.json's rows are still keyed review-code under the live `review` group", () => {
		const result = decodeFile("review.json");
		assert.isTrue(Result.isSuccess(result));
		if (Result.isSuccess(result)) {
			const rows = result.success.stages.review;
			assert.isAtLeast(rows.length, 3);
			assert.deepStrictEqual(
				rows.map((row) => row.stage),
				["review-code", "review-code", "review-code"],
			);
			// A recorded row carries no `surface` — that is a live-schema field (ADR 0243 §5).
			assert.isFalse(rows.some((row) => "surface" in row));
		}
	});
});
