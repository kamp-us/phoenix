import {assert, describe, it} from "@effect/vitest";
import {Result} from "effect";
import * as Schema from "effect/Schema";
import {
	CorpusEntry,
	type CorpusManifest,
	decodeManifest,
	encodeManifest,
	REVIEW_SURFACES,
	SKILL_RIGOR_CHECKS,
	STAGES,
} from "./corpus.ts";

const decodeEntry = Schema.decodeUnknownResult(CorpusEntry);

/** `true` iff `T` is a shape the `CorpusEntry` union admits — the type-level probe's operand. */
type Inhabits<T> = T extends CorpusEntry ? true : false;

/** A valid manifest carrying a known-good entry for every stage, and one per review surface. */
const validManifest = {
	version: 1,
	stages: {
		triage: [
			{stage: "triage", inputRef: 1848, label: {type: "chore", priority: "p1", status: "triaged"}},
		],
		build: [
			{
				stage: "build",
				inputRef: 1848,
				label: {fixesRef: 1848, ciGreen: true, reviewVerdict: "PASS"},
			},
		],
		review: [
			{
				stage: "review",
				surface: "code",
				inputRef: 1849,
				label: {verdict: "PASS", acFindings: ["AC1 met"]},
			},
			{
				stage: "review",
				surface: "doc",
				inputRef: 1850,
				label: {verdict: "FAIL", findings: ["broken link"]},
			},
			{
				stage: "review",
				surface: "skill",
				inputRef: 5038,
				label: {
					verdict: "FAIL",
					rigorFindings: [
						{check: "trigger-description-quality", finding: "description under-claims"},
					],
				},
			},
		],
		"ship-it": [{stage: "ship-it", inputRef: 1851, label: {merged: true, mergeSha: "deadbee"}}],
	},
} satisfies CorpusManifest;

describe("decodeManifest — a valid manifest per stage round-trips", () => {
	it("decodes a manifest carrying an entry under every live stage", () => {
		const result = decodeManifest(JSON.stringify(validManifest));
		assert.isTrue(Result.isSuccess(result));
		if (Result.isSuccess(result)) {
			assert.strictEqual(result.success.version, 1);
			for (const stage of STAGES) {
				assert.isAtLeast(result.success.stages[stage].length, 1);
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
	it("rejects an entry whose stage is neither a live stage nor a recorded one", () => {
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
	it("rejects a build stage carrying a triage-shaped label", () => {
		const result = decodeEntry({
			stage: "build",
			inputRef: 1848,
			label: {type: "chore", priority: "p1", status: "triaged"},
		});
		assert.isTrue(Result.isFailure(result));
	});

	it("rejects a triage stage carrying a build-shaped label", () => {
		const result = decodeEntry({
			stage: "triage",
			inputRef: 1848,
			label: {fixesRef: 1848, ciGreen: true, reviewVerdict: "PASS"},
		});
		assert.isTrue(Result.isFailure(result));
	});

	it("rejects an out-of-range verdict literal in a code-surface review label", () => {
		const result = decodeEntry({
			stage: "review",
			surface: "code",
			inputRef: 1849,
			label: {verdict: "MAYBE", acFindings: []},
		});
		assert.isTrue(Result.isFailure(result));
	});
});

// ADR 0243: the merge of the v1 review gates into one `review` stage is exactly where the module's
// unrepresentable-invalid guarantee is easiest to lose, because the three surfaces carry genuinely
// different label shapes (`acFindings` vs `findings` vs `rigorFindings`). It now holds over the
// (stage, surface) PAIR, and these prove it at both layers — the schema and the type.
describe("review — a label mismatched to its surface stays unrepresentable", () => {
	const docShapedLabel = {verdict: "PASS", findings: ["broken link"]};
	const codeShapedLabel = {verdict: "PASS", acFindings: ["AC1 met"]};
	const skillShapedLabel = {
		verdict: "PASS",
		rigorFindings: [{check: "fabrika-conventions", finding: "restates a sibling's behavior"}],
	};

	it("rejects a doc-shaped label under surface code", () => {
		const result = decodeEntry({
			stage: "review",
			surface: "code",
			inputRef: 1,
			label: docShapedLabel,
		});
		assert.isTrue(Result.isFailure(result));
	});

	it("rejects a code-shaped label under surface doc", () => {
		const result = decodeEntry({
			stage: "review",
			surface: "doc",
			inputRef: 1,
			label: codeShapedLabel,
		});
		assert.isTrue(Result.isFailure(result));
	});

	it("a manifest carrying the surface-mismatched row fails decodeManifest with schema-mismatch", () => {
		const bad = {
			...validManifest,
			stages: {
				...validManifest.stages,
				review: [{stage: "review", surface: "code", inputRef: 1, label: docShapedLabel}],
			},
		};
		const result = decodeManifest(JSON.stringify(bad));
		assert.isTrue(Result.isFailure(result));
		if (Result.isFailure(result)) {
			assert.strictEqual(result.failure.reason, "schema-mismatch");
		}
	});

	it("rejects a review entry with no surface at all — no default, no inferred rubric", () => {
		const result = decodeEntry({stage: "review", inputRef: 1, label: codeShapedLabel});
		assert.isTrue(Result.isFailure(result));
	});

	it("rejects a surface outside the three ADR 0243 names", () => {
		const result = decodeEntry({
			stage: "review",
			surface: "design",
			inputRef: 1,
			label: codeShapedLabel,
		});
		assert.isTrue(Result.isFailure(result));
	});

	it("rejects a code-shaped label under surface skill", () => {
		const result = decodeEntry({
			stage: "review",
			surface: "skill",
			inputRef: 1,
			label: codeShapedLabel,
		});
		assert.isTrue(Result.isFailure(result));
	});

	it("rejects a skill-shaped label under surface doc", () => {
		const result = decodeEntry({
			stage: "review",
			surface: "doc",
			inputRef: 1,
			label: skillShapedLabel,
		});
		assert.isTrue(Result.isFailure(result));
	});

	it("rejects a rigor finding attributed to a check outside the rubric's closed set", () => {
		const result = decodeEntry({
			stage: "review",
			surface: "skill",
			inputRef: 1,
			// The rubric assigns gate-invariant preservation to the `governance` skill and says it is
			// never graded here — so no corpus row may attribute a finding to it (ADR 0243 §1a).
			label: {
				verdict: "FAIL",
				rigorFindings: [{check: "gate-invariant-preservation", finding: "a guard was dropped"}],
			},
		});
		assert.isTrue(Result.isFailure(result));
	});

	it("rejects a rigor finding that carries no check attribution", () => {
		const result = decodeEntry({
			stage: "review",
			surface: "skill",
			inputRef: 1,
			label: {verdict: "FAIL", rigorFindings: [{finding: "a bare string finding"}]},
		});
		assert.isTrue(Result.isFailure(result));
	});

	it("is refused by the type, not only by the decoder", () => {
		// The runtime half above is not the whole guarantee: a `CorpusEntry` type that ADMITTED the
		// mismatch would still decode-fail, so the compiler has to refuse it too. `Inhabits<T>` is
		// `false` exactly when T is not a CorpusEntry, so these constants stop compiling the moment
		// the pair discriminator is weakened into an annotation — and the positive control keeps
		// them from being vacuously true.
		const wellFormed: Inhabits<{
			stage: "review";
			surface: "code";
			inputRef: number;
			label: {verdict: "PASS"; acFindings: ReadonlyArray<string>};
		}> = true;
		const surfaceMismatched: Inhabits<{
			stage: "review";
			surface: "code";
			inputRef: number;
			label: {verdict: "PASS"; findings: ReadonlyArray<string>};
		}> = false;
		const surfaceless: Inhabits<{
			stage: "review";
			inputRef: number;
			label: {verdict: "PASS"; acFindings: ReadonlyArray<string>};
		}> = false;
		const skillWellFormed: Inhabits<{
			stage: "review";
			surface: "skill";
			inputRef: number;
			label: {
				verdict: "PASS";
				rigorFindings: ReadonlyArray<{check: "cross-skill-conflict"; finding: string}>;
			};
		}> = true;
		const skillFlatFindings: Inhabits<{
			stage: "review";
			surface: "skill";
			inputRef: number;
			label: {verdict: "PASS"; findings: ReadonlyArray<string>};
		}> = false;
		const skillUnknownCheck: Inhabits<{
			stage: "review";
			surface: "skill";
			inputRef: number;
			label: {
				verdict: "PASS";
				rigorFindings: ReadonlyArray<{check: "gate-invariant-preservation"; finding: string}>;
			};
		}> = false;

		assert.isTrue(wellFormed);
		assert.isFalse(surfaceMismatched);
		assert.isFalse(surfaceless);
		assert.isTrue(skillWellFormed);
		assert.isFalse(skillFlatFindings);
		assert.isFalse(skillUnknownCheck);
	});
});

// The founder ruling on #4977: a recorded row's stage key is provenance, so the decoder has to keep
// reading `write-code` even though nothing live is named that any more.
describe("recorded provenance — a v1 `write-code` row survives the re-key unrelabelled", () => {
	const recorded = {
		stage: "write-code",
		inputRef: 1223,
		label: {fixesRef: 1223, ciGreen: true, reviewVerdict: "PASS"},
	};

	it("decodes under the live `build` group without its own key changing", () => {
		const manifest = {
			...validManifest,
			stages: {...validManifest.stages, build: [recorded]},
		};
		const result = decodeManifest(JSON.stringify(manifest));
		assert.isTrue(Result.isSuccess(result));
		if (Result.isSuccess(result)) {
			assert.strictEqual(result.success.stages.build[0]?.stage, "write-code");
		}
	});

	it("is still shape-checked — a triage-shaped label under it is rejected", () => {
		const result = decodeEntry({
			stage: "write-code",
			inputRef: 1223,
			label: {type: "chore", priority: "p1", status: "triaged"},
		});
		assert.isTrue(Result.isFailure(result));
	});

	it("is not a live stage — STAGES names `build` and not `write-code`", () => {
		assert.include(STAGES as ReadonlyArray<string>, "build");
		assert.notInclude(STAGES as ReadonlyArray<string>, "write-code");
	});
});

// The same ruling, applied to the two review keys the merge absorbs.
describe("recorded provenance — the v1 review rows survive the merge unrelabelled", () => {
	const recordedCode = {
		stage: "review-code",
		inputRef: 1199,
		label: {verdict: "PASS", acFindings: ["AC1 met"]},
	};
	const recordedDoc = {
		stage: "review-doc",
		inputRef: 1850,
		label: {verdict: "FAIL", findings: ["broken link"]},
	};

	it("both decode under the live `review` group without their own keys changing", () => {
		const manifest = {
			...validManifest,
			stages: {...validManifest.stages, review: [recordedCode, recordedDoc]},
		};
		const result = decodeManifest(JSON.stringify(manifest));
		assert.isTrue(Result.isSuccess(result));
		if (Result.isSuccess(result)) {
			assert.deepStrictEqual(
				result.success.stages.review.map((row) => row.stage),
				["review-code", "review-doc"],
			);
		}
	});

	it("are still shape-checked — a doc label under the recorded review-code key is rejected", () => {
		const result = decodeEntry({
			stage: "review-code",
			inputRef: 1199,
			label: {verdict: "PASS", findings: []},
		});
		assert.isTrue(Result.isFailure(result));
	});

	it("are not live stages — STAGES names `review` and neither v1 key", () => {
		assert.include(STAGES as ReadonlyArray<string>, "review");
		assert.notInclude(STAGES as ReadonlyArray<string>, "review-code");
		assert.notInclude(STAGES as ReadonlyArray<string>, "review-doc");
	});
});

describe("the review surface vocabulary is ADR 0243's three", () => {
	it("REVIEW_SURFACES names every surface whose label shape ADR 0243 fixes", () => {
		assert.deepStrictEqual([...REVIEW_SURFACES], ["code", "doc", "skill"]);
	});

	it("SKILL_RIGOR_CHECKS names the rubric's four checks and excludes the governance one", () => {
		assert.deepStrictEqual(
			[...SKILL_RIGOR_CHECKS],
			[
				"behavioral-correctness",
				"trigger-description-quality",
				"cross-skill-conflict",
				"fabrika-conventions",
			],
		);
		assert.notInclude(SKILL_RIGOR_CHECKS as ReadonlyArray<string>, "gate-invariant-preservation");
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
