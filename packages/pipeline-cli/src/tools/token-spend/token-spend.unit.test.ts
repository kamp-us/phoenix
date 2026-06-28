import {assert, describe, it} from "@effect/vitest";
import {
	formatStageSpend,
	reconstructSpend,
	type StageSpend,
	toSessionCostInput,
} from "./token-spend.ts";

/** Build one transcript line for an assistant message with the given usage components. */
const assistantLine = (
	usage: Partial<{
		input_tokens: number;
		cache_creation_input_tokens: number;
		cache_read_input_tokens: number;
		output_tokens: number;
	}>,
	model = "claude-opus-4-8",
): string => JSON.stringify({type: "assistant", message: {role: "assistant", model, usage}});

describe("reconstructSpend — four-component billed reconstruction (pattern §2)", () => {
	it("sums the four usage components over assistant messages into billed", () => {
		const transcript = [
			assistantLine({
				input_tokens: 10,
				cache_creation_input_tokens: 20,
				cache_read_input_tokens: 100,
				output_tokens: 5,
			}),
			assistantLine({
				input_tokens: 1,
				cache_creation_input_tokens: 2,
				cache_read_input_tokens: 300,
				output_tokens: 3,
			}),
		].join("\n");

		const spend = reconstructSpend(transcript);
		assert.strictEqual(spend.input, 11);
		assert.strictEqual(spend.cacheCreate, 22);
		assert.strictEqual(spend.cacheRead, 400);
		assert.strictEqual(spend.output, 8);
		// billed = input + cache_create + cache_read + output
		assert.strictEqual(spend.billed, 11 + 22 + 400 + 8);
		// ex-cache-read = input + cache_create + output (no per-turn cache_read)
		assert.strictEqual(spend.exCacheRead, 11 + 22 + 8);
		assert.strictEqual(spend.assistantTurns, 2);
		assert.strictEqual(spend.model, "claude-opus-4-8");
	});

	it("reproduces a recorded baseline row (triage agent-af3afc3fc26976: billed 592,499 / ex-cache-read 175,425)", () => {
		// One synthetic assistant message whose components add to the §2 recorded triage row.
		// input + cache_create + output = ex-cache-read (175,425); + cache_read = billed (592,499).
		const cacheRead = 592_499 - 175_425;
		const transcript = assistantLine({
			input_tokens: 170_830,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: cacheRead,
			output_tokens: 4_595,
		});
		const spend = reconstructSpend(transcript);
		assert.strictEqual(spend.billed, 592_499);
		assert.strictEqual(spend.exCacheRead, 175_425);
		assert.strictEqual(spend.output, 4_595);
	});

	it("counts only assistant messages — skips user/system/result lines", () => {
		const transcript = [
			JSON.stringify({type: "user", message: {role: "user", content: "Triage issue #1227"}}),
			assistantLine({input_tokens: 5, output_tokens: 2}),
			JSON.stringify({type: "result", message: {role: "system"}}),
		].join("\n");
		const spend = reconstructSpend(transcript);
		assert.strictEqual(spend.assistantTurns, 1);
		assert.strictEqual(spend.input, 5);
		assert.strictEqual(spend.output, 2);
	});

	it("skips assistant messages with no usage block (no crash, no count)", () => {
		const transcript = [
			JSON.stringify({type: "assistant", message: {role: "assistant", content: "hi"}}),
			assistantLine({input_tokens: 7}),
		].join("\n");
		const spend = reconstructSpend(transcript);
		assert.strictEqual(spend.assistantTurns, 1);
		assert.strictEqual(spend.input, 7);
	});

	it("is total over malformed input — non-JSON / blank lines are skipped, never thrown", () => {
		const transcript = [
			"",
			"   ",
			"not json at all",
			"{broken",
			assistantLine({input_tokens: 9}),
		].join("\n");
		const spend = reconstructSpend(transcript);
		assert.strictEqual(spend.assistantTurns, 1);
		assert.strictEqual(spend.input, 9);
	});

	it("treats missing / non-numeric / negative usage fields as 0", () => {
		const transcript = [
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					usage: {input_tokens: "lots", cache_read_input_tokens: -5, output_tokens: 4},
				},
			}),
		].join("\n");
		const spend = reconstructSpend(transcript);
		assert.strictEqual(spend.input, 0); // non-numeric → 0
		assert.strictEqual(spend.cacheRead, 0); // negative → 0
		assert.strictEqual(spend.cacheCreate, 0); // missing → 0
		assert.strictEqual(spend.output, 4);
		assert.strictEqual(spend.billed, 4);
	});

	it("returns an all-zero spend with null model for an empty transcript", () => {
		const spend = reconstructSpend("");
		assert.strictEqual(spend.billed, 0);
		assert.strictEqual(spend.assistantTurns, 0);
		assert.strictEqual(spend.model, null);
	});
});

describe("toSessionCostInput — reuse spawn-guard's SessionCostInput shape", () => {
	it("maps billed → totalTokens, omits cost (not persisted in the transcript), carries model", () => {
		const spend: StageSpend = {
			input: 1,
			cacheCreate: 2,
			cacheRead: 3,
			output: 4,
			billed: 10,
			exCacheRead: 7,
			assistantTurns: 1,
			model: "claude-opus-4-8",
		};
		const input = toSessionCostInput(spend);
		assert.strictEqual(input.totalTokens, 10);
		assert.strictEqual(input.totalCostUsd, null);
		assert.strictEqual(input.model, "claude-opus-4-8");
	});
});

describe("formatStageSpend — formatSessionCost headline + four-component breakdown", () => {
	const spend = reconstructSpend(
		assistantLine({
			input_tokens: 170_830,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 592_499 - 175_425,
			output_tokens: 4_595,
		}),
	);
	const report = formatStageSpend(spend);

	it("leads with the formatSessionCost headline (model · billed tokens)", () => {
		const headline = report.split("\n")[0];
		// formatSessionCost renders billed (592,499) as ~592.5K tok with the model prefix.
		assert.strictEqual(headline, "claude-opus-4-8 · 592.5K tok");
	});

	it("keeps cache_read visible on its own line, labelled as the context-bloat signal", () => {
		assert.match(report, /cache_read: +417,074 +\(re-read every turn/);
	});

	it("shows ex-cache-read as the cross-run comparator", () => {
		assert.match(report, /ex-cache-read: +175,425 +\(cross-run comparator\)/);
	});

	it("renders the four components + billed with thousands separators", () => {
		assert.match(report, /billed: +592,499/);
		assert.match(report, /output: +4,595/);
	});
});
