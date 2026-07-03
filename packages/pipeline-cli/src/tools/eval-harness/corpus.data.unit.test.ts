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
		assert.deepStrictEqual(manifestFiles, ["review-code.json", "triage.json", "write-code.json"]);
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
		{file: "write-code.json", stage: "write-code", seed: 1223, min: 3},
		{file: "review-code.json", stage: "review-code", seed: 1199, min: 3},
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
