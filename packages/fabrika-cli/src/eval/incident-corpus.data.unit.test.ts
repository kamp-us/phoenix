import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {Result} from "effect";
import {decodeIncidentProvenance, provenanceViolations} from "./incident-provenance.ts";
import {decodeSkillEvalSet} from "./skill-eval-set.ts";

const read = (leaf: string) =>
	readFileSync(fileURLToPath(new URL(`./incident-corpus/${leaf}`, import.meta.url)), "utf8");

const evalSet = () => {
	const result = decodeSkillEvalSet(read("evals.json"));
	assert.isTrue(Result.isSuccess(result), "incident-corpus/evals.json must decode to Ok");
	if (!Result.isSuccess(result)) throw new Error("unreachable");
	return result.success;
};

const provenance = () => {
	const result = decodeIncidentProvenance(read("provenance.json"));
	assert.isTrue(Result.isSuccess(result), "incident-corpus/provenance.json must decode to Ok");
	if (!Result.isSuccess(result)) throw new Error("unreachable");
	return result.success;
};

describe("incident corpus — every committed case decodes through the ingestion verb", () => {
	it("evals.json decodes as a skill eval set", () => {
		assert.isAtLeast(evalSet().cases.length, 1);
	});

	it("every case carries a prompt and at least one assertion", () => {
		for (const testCase of evalSet().cases) {
			assert.notStrictEqual(testCase.prompt.trim(), "", `case ${testCase.id} has no prompt`);
			assert.isAtLeast(testCase.assertions.length, 1, `case ${testCase.id} has no assertions`);
		}
	});

	it("provenance.json decodes and holds its own integrity rules", () => {
		assert.deepStrictEqual(provenanceViolations(provenance()), []);
	});
});

describe("incident corpus — every case is bound to a real, cited incident", () => {
	it("the case ids in the eval set and the provenance ledger are the same set", () => {
		const authored = evalSet()
			.cases.map((c) => c.id)
			.sort((a, b) => a - b);
		const recorded = provenance()
			.cases.map((c) => c.id)
			.sort((a, b) => a - b);
		assert.deepStrictEqual(recorded, authored);
	});

	it("each of the three verified v1 failure modes is represented, portability included", () => {
		const byId = new Map(provenance().cases.map((c) => [c.id, c]));
		// #4632's three VERIFIED modes: contract-drift, silent-green-127, foreign-root portability.
		for (const id of [1, 2, 3]) {
			const entry = byId.get(id);
			assert.isDefined(entry, `case ${id} must exist`);
			assert.include(entry?.incidents ?? [], "#4632", `case ${id} must cite #4632`);
		}
		assert.include(byId.get(3)?.incidents ?? [], "#4605");
	});

	it("no parked v1 defect ticket is silently dropped", () => {
		const ledger = provenance();
		const cited = new Set(ledger.cases.flatMap((c) => c.incidents));
		const declined = new Set(ledger.declined.map((d) => d.incident));
		for (const parked of ["#4659", "#4660", "#4663", "#4664", "#4666", "#4667", "#4671"]) {
			assert.isTrue(
				cited.has(parked) || declined.has(parked),
				`${parked} is neither a case nor a recorded decline`,
			);
		}
	});
});

describe("incident corpus — the deterministic tier is the default, graded is the stated exception", () => {
	it("each case's derived tier matches the tier its provenance declares", () => {
		const declared = new Map(provenance().cases.map((c) => [c.id, c.tier]));
		for (const testCase of evalSet().cases) {
			assert.strictEqual(
				testCase.tier,
				declared.get(testCase.id),
				`case ${testCase.id}: derived tier disagrees with the declared one`,
			);
		}
	});

	it("every graded case states why it could not be pushed to the deterministic layer", () => {
		const graded = provenance().cases.filter((c) => c.tier === "graded");
		assert.isBelow(
			graded.length,
			provenance().cases.length,
			"graded is the exception, not the rule",
		);
		for (const entry of graded) {
			assert.isTrue(
				entry.tier === "graded" && entry.tierRationale.length > 40,
				`case ${entry.id}: graded rationale must say something`,
			);
		}
	});
});
