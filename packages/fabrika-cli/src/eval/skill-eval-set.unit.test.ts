import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {Result} from "effect";
import {
	decodeEvalCaseMetadata,
	decodeSkillEvalSet,
	deriveAssertion,
	deriveTier,
	type SkillEvalSet,
	tierCounts,
	withCaseMetadata,
} from "./skill-eval-set.ts";

// The fixture is a verbatim /skill-creator authoring-session output shape: an `evals/evals.json`
// case list plus one per-case `eval_metadata.json` sidecar, unedited.
const readFixture = (relative: string) =>
	readFileSync(
		fileURLToPath(new URL(`./fixtures/skill-creator/${relative}`, import.meta.url)),
		"utf8",
	);

const evalsJson = readFixture("evals.json");
const sidecarJson = readFixture("eval-3/eval_metadata.json");

const decoded = (): SkillEvalSet => {
	const result = decodeSkillEvalSet(evalsJson);
	assert.isTrue(Result.isSuccess(result), "the fixture eval set must decode to Ok");
	if (Result.isFailure(result)) throw new Error(result.failure.message);
	return result.success;
};

describe("decodeSkillEvalSet — an unedited /skill-creator eval set decodes", () => {
	it("decodes the authored file with no edits and no added required field", () => {
		const set = decoded();
		assert.strictEqual(set.skillName, "example-skill");
		assert.deepStrictEqual(
			set.cases.map((c) => c.id),
			[0, 1, 2, 3],
		);
	});

	it("carries the authored optional fields through, defaulting the absent ones", () => {
		const set = decoded();
		const [first, second, , fourth] = set.cases;
		assert.strictEqual(first?.expectedOutput, "A new NNNN-slug.md record, and a zero exit code.");
		assert.deepStrictEqual(first?.files, []);
		assert.deepStrictEqual(second?.files, ["evals/files/0231-sample-record.md"]);
		// The session writes prompts first and drafts assertions later, so a case with no
		// `expectations` key must still decode — as zero assertions, not as a failure.
		assert.deepStrictEqual(fourth?.assertions, []);
	});

	// The two are different claims, and the staging tier reads them differently (#5434): `[]` says the
	// case needs no material, an absent key says nothing at all. Collapsing them here is what let a
	// case with no declaration score out of an empty directory.
	it("keeps an absent `files` key distinct from an authored empty one", () => {
		const result = decodeSkillEvalSet(
			JSON.stringify({
				skill_name: "example-skill",
				evals: [
					{id: 0, prompt: "no files key at all"},
					{id: 1, prompt: "declares it needs none", files: []},
				],
			}),
		);
		assert.isTrue(Result.isSuccess(result));
		if (Result.isSuccess(result)) {
			assert.strictEqual(result.success.cases[0]?.files, null);
			assert.deepStrictEqual(result.success.cases[1]?.files, []);
		}
	});

	it("accepts the `assertions` key the authoring SKILL.md names, not only `expectations`", () => {
		const result = decodeSkillEvalSet(
			JSON.stringify({
				skill_name: "example-skill",
				evals: [{id: 0, prompt: "p", assertions: ["The command exits 0"]}],
			}),
		);
		assert.isTrue(Result.isSuccess(result));
		if (Result.isSuccess(result)) {
			assert.strictEqual(result.success.cases[0]?.assertions.length, 1);
			assert.strictEqual(result.success.cases[0]?.tier, "deterministic");
		}
	});

	it("accepts an assertion written as a {text} object as well as a bare string", () => {
		const result = decodeSkillEvalSet(
			JSON.stringify({
				skill_name: "example-skill",
				evals: [{id: 0, prompt: "p", expectations: [{text: "The command exits 0"}]}],
			}),
		);
		assert.isTrue(Result.isSuccess(result));
		if (Result.isSuccess(result)) {
			assert.deepStrictEqual(result.success.cases[0]?.assertions, [
				{kind: "mechanical", text: "The command exits 0", cue: "exit-status"},
			]);
		}
	});
});

describe("decodeSkillEvalSet — total on bad input (never throws)", () => {
	it("returns a typed malformed-json failure on a non-JSON body", () => {
		const result = decodeSkillEvalSet("not json at all {");
		assert.isTrue(Result.isFailure(result));
		if (Result.isFailure(result)) {
			assert.strictEqual(result.failure._tag, "SkillEvalSetDecodeError");
			assert.strictEqual(result.failure.reason, "malformed-json");
			assert.isNotEmpty(result.failure.message);
		}
	});

	it("returns a typed schema-mismatch failure when `evals` is not a list of cases", () => {
		const result = decodeSkillEvalSet(JSON.stringify({skill_name: "x", evals: "none"}));
		assert.isTrue(Result.isFailure(result));
		if (Result.isFailure(result)) {
			assert.strictEqual(result.failure.reason, "schema-mismatch");
		}
	});

	it("returns a typed schema-mismatch failure when a case is missing its prompt", () => {
		const result = decodeSkillEvalSet(
			JSON.stringify({skill_name: "x", evals: [{id: 0, expectations: []}]}),
		);
		assert.isTrue(Result.isFailure(result));
		if (Result.isFailure(result)) {
			assert.strictEqual(result.failure.reason, "schema-mismatch");
		}
	});

	it("returns a typed schema-mismatch failure on a non-integer case id", () => {
		const result = decodeSkillEvalSet(
			JSON.stringify({skill_name: "x", evals: [{id: "zero", prompt: "p"}]}),
		);
		assert.isTrue(Result.isFailure(result));
		if (Result.isFailure(result)) {
			assert.strictEqual(result.failure.reason, "schema-mismatch");
		}
	});
});

describe("deriveAssertion — the kind is derived, and the default is the safe tier", () => {
	it("names the observable an exit-status assertion checks", () => {
		assert.deepStrictEqual(deriveAssertion("The command exits non-zero"), {
			kind: "mechanical",
			text: "The command exits non-zero",
			cue: "exit-status",
		});
	});

	it("names the observable a file-artifact assertion checks", () => {
		const derived = deriveAssertion("A file named report.md exists");
		assert.strictEqual(derived.kind, "mechanical");
		if (derived.kind === "mechanical") assert.strictEqual(derived.cue, "file-artifact");
	});

	it("names the observable an output-content assertion checks", () => {
		const derived = deriveAssertion("The output includes the record path");
		assert.strictEqual(derived.kind, "mechanical");
		if (derived.kind === "mechanical") assert.strictEqual(derived.cue, "output-content");
	});

	it("falls through to judgment on prose no cue matches", () => {
		assert.deepStrictEqual(deriveAssertion("The record reads as a decision, not a summary"), {
			kind: "judgment",
			text: "The record reads as a decision, not a summary",
		});
	});

	it("matches a cue case-insensitively", () => {
		assert.strictEqual(deriveAssertion("EXIT CODE is 0").kind, "mechanical");
	});
});

describe("deriveTier — the tier comes from the assertions, not from a field", () => {
	it("routes an all-mechanical case to the deterministic tier", () => {
		const set = decoded();
		assert.strictEqual(set.cases[0]?.tier, "deterministic");
	});

	it("routes an all-judgment case to the graded tier", () => {
		const set = decoded();
		assert.strictEqual(set.cases[1]?.tier, "graded");
	});

	it("routes a mixed case to the graded tier — one judgment assertion needs the grader", () => {
		const set = decoded();
		assert.strictEqual(set.cases[2]?.tier, "graded");
	});

	it("routes a case with no assertions yet to the graded tier", () => {
		assert.strictEqual(deriveTier([]), "graded");
	});

	it("counts the tiers over a set", () => {
		assert.deepStrictEqual(tierCounts(decoded()), {deterministic: 1, graded: 3});
	});
});

describe("decodeEvalCaseMetadata — the sidecar decodes unedited", () => {
	it("decodes an unedited eval_metadata.json", () => {
		const result = decodeEvalCaseMetadata(sidecarJson);
		assert.isTrue(Result.isSuccess(result));
		if (Result.isSuccess(result)) {
			assert.strictEqual(result.success.id, 3);
			assert.strictEqual(result.success.name, "renumber-after-a-collision");
			assert.strictEqual(result.success.assertions.length, 2);
		}
	});

	it("decodes a sidecar written before its assertions were drafted", () => {
		const result = decodeEvalCaseMetadata(
			JSON.stringify({eval_id: 0, eval_name: "n", prompt: "p", assertions: []}),
		);
		assert.isTrue(Result.isSuccess(result));
	});

	it("is total: a malformed body and a schema mismatch both return a typed failure", () => {
		const malformed = decodeEvalCaseMetadata("{");
		assert.isTrue(Result.isFailure(malformed));
		if (Result.isFailure(malformed)) assert.strictEqual(malformed.failure.reason, "malformed-json");

		const mismatched = decodeEvalCaseMetadata(JSON.stringify({eval_id: "three", prompt: "p"}));
		assert.isTrue(Result.isFailure(mismatched));
		if (Result.isFailure(mismatched)) {
			assert.strictEqual(mismatched.failure.reason, "schema-mismatch");
		}
	});
});

describe("withCaseMetadata — a sidecar fills, and never overrides the authored set", () => {
	it("fills a case whose set entry has no assertions yet, re-deriving its tier", () => {
		const sidecar = decodeEvalCaseMetadata(sidecarJson);
		assert.isTrue(Result.isSuccess(sidecar));
		if (Result.isFailure(sidecar)) return;
		const joined = withCaseMetadata(decoded(), [sidecar.success]);
		const filled = joined.cases[3];
		assert.strictEqual(filled?.name, "renumber-after-a-collision");
		assert.strictEqual(filled?.assertions.length, 2);
		assert.strictEqual(filled?.tier, "deterministic");
	});

	it("leaves a case that already carries assertions alone", () => {
		const joined = withCaseMetadata(decoded(), [
			{id: 0, name: "sidecar-name", prompt: "p", assertions: []},
		]);
		assert.strictEqual(joined.cases[0]?.assertions.length, 3);
		assert.strictEqual(joined.cases[0]?.tier, "deterministic");
	});

	it("ignores a sidecar for an id the set does not carry", () => {
		const joined = withCaseMetadata(decoded(), [
			{id: 99, name: "dropped-iteration", prompt: "p", assertions: []},
		]);
		assert.deepStrictEqual(joined, decoded());
	});
});
