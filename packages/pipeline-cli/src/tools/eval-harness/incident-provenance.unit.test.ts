import {assert, describe, it} from "@effect/vitest";
import {Result} from "effect";
import {decodeIncidentProvenance, provenanceViolations} from "./incident-provenance.ts";

const deterministicCase = {
	id: 1,
	tier: "deterministic",
	title: "a case",
	incidents: ["#4632"],
	verification: ["verified against the issue"],
	corrections: [],
};

const ledger = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify({
		corpus: "fabrika-incident-corpus",
		cases: [deterministicCase],
		declined: [],
		...overrides,
	});

describe("decodeIncidentProvenance — total, typed failures", () => {
	it("decodes a well-formed ledger", () => {
		const result = decodeIncidentProvenance(ledger());
		assert.isTrue(Result.isSuccess(result));
		if (Result.isSuccess(result)) {
			assert.strictEqual(result.success.cases.length, 1);
			assert.strictEqual(result.success.cases[0]?.tier, "deterministic");
		}
	});

	it("fails malformed-json on a non-JSON body rather than throwing", () => {
		const result = decodeIncidentProvenance("{not json");
		assert.isTrue(Result.isFailure(result));
		if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "malformed-json");
	});

	it("fails schema-mismatch on a case missing its verification", () => {
		const {verification: _dropped, ...withoutVerification} = deterministicCase;
		const result = decodeIncidentProvenance(ledger({cases: [withoutVerification]}));
		assert.isTrue(Result.isFailure(result));
		if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "schema-mismatch");
	});

	it("refuses a graded case with no rationale — the exception cannot be taken silently", () => {
		const result = decodeIncidentProvenance(
			ledger({cases: [{...deterministicCase, tier: "graded"}]}),
		);
		assert.isTrue(Result.isFailure(result));
		if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "schema-mismatch");
	});

	it("accepts a graded case that states its rationale", () => {
		const result = decodeIncidentProvenance(
			ledger({cases: [{...deterministicCase, tier: "graded", tierRationale: "no observable cue"}]}),
		);
		assert.isTrue(Result.isSuccess(result));
	});

	it("keeps a correction beside the claim it retracts, not in place of it", () => {
		const corrected = {
			...deterministicCase,
			corrections: [{at: "2026-08-01", source: "#4675 comment 5153283658", summary: "retracted"}],
		};
		const result = decodeIncidentProvenance(ledger({cases: [corrected]}));
		assert.isTrue(Result.isSuccess(result));
		if (Result.isSuccess(result)) {
			assert.strictEqual(result.success.cases[0]?.corrections.length, 1);
			assert.strictEqual(result.success.cases[0]?.verification.length, 1);
		}
	});
});

describe("provenanceViolations — the claims a well-shaped ledger can still make falsely", () => {
	const decoded = (text: string) => {
		const result = decodeIncidentProvenance(text);
		assert.isTrue(Result.isSuccess(result));
		if (!Result.isSuccess(result)) throw new Error("unreachable");
		return result.success;
	};

	it("passes a ledger whose every case cites and verifies an incident", () => {
		assert.deepStrictEqual(provenanceViolations(decoded(ledger())), []);
	});

	it("names a case that cites no incident", () => {
		const violations = provenanceViolations(
			decoded(ledger({cases: [{...deterministicCase, incidents: []}]})),
		);
		assert.deepStrictEqual(violations, ["case 1: cites no incident"]);
	});

	it("names a citation that is not an issue number", () => {
		const violations = provenanceViolations(
			decoded(ledger({cases: [{...deterministicCase, incidents: ["the one from last night"]}]})),
		);
		assert.deepStrictEqual(violations, [
			"case 1: incident the one from last night is not a #NNNN citation",
		]);
	});

	it("names a case admitted with no verification behind it", () => {
		const violations = provenanceViolations(
			decoded(ledger({cases: [{...deterministicCase, verification: []}]})),
		);
		assert.deepStrictEqual(violations, ["case 1: records no verification"]);
	});

	it("names a duplicate case id", () => {
		const violations = provenanceViolations(
			decoded(ledger({cases: [deterministicCase, deterministicCase]})),
		);
		assert.deepStrictEqual(violations, ["case 1: duplicate id"]);
	});

	it("names a graded case whose rationale is blank space", () => {
		const violations = provenanceViolations(
			decoded(ledger({cases: [{...deterministicCase, tier: "graded", tierRationale: "   "}]})),
		);
		assert.deepStrictEqual(violations, ["case 1: graded with an empty rationale"]);
	});

	it("names a declined incident with no reason", () => {
		const violations = provenanceViolations(
			decoded(ledger({declined: [{incident: "#1", reason: ""}]})),
		);
		assert.deepStrictEqual(violations, ["declined #1: no reason recorded"]);
	});
});
