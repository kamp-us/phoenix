/**
 * The fabrika half of the one-ruler proof (#4777).
 *
 * ADR 0238 has fabrika re-implement v1's token meter rather than call it, which would leave two
 * implementations of one specified formula free to drift. The shared fixture below is what closes
 * that: `fixtures/one-ruler/transcript.jsonl` plus its expected figures are asserted here **and**
 * by v1's `packages/pipeline-cli/src/tools/token-spend/token-spend.unit.test.ts`, so the two are
 * pinned to one set of numbers instead of trusted to agree. Editing the fixture without editing
 * `expected.json` reds both suites, which is the point.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {reconstructSpend, type StageSpend} from "./token-spend.ts";

const read = (name: string): string =>
	readFileSync(fileURLToPath(new URL(`./fixtures/one-ruler/${name}`, import.meta.url)), "utf8");

describe("reconstructSpend — the shared one-ruler fixture (ADR 0112 §2)", () => {
	const spend = reconstructSpend(read("transcript.jsonl"));
	const expected = JSON.parse(read("expected.json")) as StageSpend;

	it("reproduces every component of the committed expectation", () => {
		assert.deepStrictEqual(spend, expected);
	});

	it("derives billed as the sum of the four usage components, not as a stored aggregate", () => {
		assert.strictEqual(
			spend.billed,
			spend.input + spend.cacheCreate + spend.cacheRead + spend.output,
		);
	});

	it("keeps ex-cache-read as the comparator that does not re-count the cached prefix", () => {
		assert.strictEqual(spend.exCacheRead, spend.billed - spend.cacheRead);
	});

	it("counts only assistant turns that carried usage — the fixture's other lines are skipped", () => {
		assert.strictEqual(spend.assistantTurns, 3);
	});
});

describe("reconstructSpend — total over anything a transcript can hold", () => {
	it("is all zeros with no model for an empty transcript, never a throw", () => {
		const spend = reconstructSpend("");
		assert.strictEqual(spend.billed, 0);
		assert.strictEqual(spend.assistantTurns, 0);
		assert.strictEqual(spend.model, null);
	});

	it("treats a missing, non-numeric or negative usage field as 0 rather than trusting it", () => {
		const spend = reconstructSpend(
			JSON.stringify({
				message: {
					role: "assistant",
					usage: {input_tokens: "lots", cache_read_input_tokens: -5, output_tokens: 4},
				},
			}),
		);
		assert.strictEqual(spend.input, 0);
		assert.strictEqual(spend.cacheRead, 0);
		assert.strictEqual(spend.cacheCreate, 0);
		assert.strictEqual(spend.billed, 4);
	});
});
