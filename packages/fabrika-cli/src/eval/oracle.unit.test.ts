import {assert, describe, it} from "@effect/vitest";
import type {CorpusEntry} from "./corpus.ts";
import {type Grade, gradeEntry} from "./oracle.ts";

// A known-good entry + its matching (passing) artifact per stage. The artifact mirrors the
// label shape (observed decision artifact vs expected label — ADR 0112 §3).
const cases = {
	triage: {
		entry: {
			stage: "triage",
			inputRef: 1848,
			label: {type: "chore", priority: "p1", status: "triaged"},
		},
		passing: {type: "chore", priority: "p1", status: "triaged"},
	},
	build: {
		entry: {
			stage: "build",
			inputRef: 1848,
			label: {fixesRef: 1848, ciGreen: true, reviewVerdict: "PASS"},
		},
		passing: {fixesRef: 1848, ciGreen: true, reviewVerdict: "PASS"},
	},
	// A recorded v1 row keeps its own stage key (#4977) and must still reach a grader.
	"write-code": {
		entry: {
			stage: "write-code",
			inputRef: 1223,
			label: {fixesRef: 1223, ciGreen: true, reviewVerdict: "PASS"},
		},
		passing: {fixesRef: 1223, ciGreen: true, reviewVerdict: "PASS"},
	},
	"review/code": {
		entry: {
			stage: "review",
			surface: "code",
			inputRef: 1849,
			label: {verdict: "PASS", acFindings: ["AC1 met", "AC2 met"]},
		},
		passing: {verdict: "PASS", acFindings: ["AC2 met", "AC1 met"]}, // set-equal, reordered
	},
	"review/doc": {
		entry: {
			stage: "review",
			surface: "doc",
			inputRef: 1850,
			label: {verdict: "FAIL", findings: ["broken link"]},
		},
		passing: {verdict: "FAIL", findings: ["broken link"]},
	},
	"review/skill": {
		entry: {
			stage: "review",
			surface: "skill",
			inputRef: 5038,
			label: {
				verdict: "FAIL",
				rigorFindings: [
					{check: "trigger-description-quality", finding: "description under-claims"},
					{check: "fabrika-conventions", finding: "restates a sibling's behavior"},
				],
			},
		},
		// set-equal, reordered
		passing: {
			verdict: "FAIL",
			rigorFindings: [
				{check: "fabrika-conventions", finding: "restates a sibling's behavior"},
				{check: "trigger-description-quality", finding: "description under-claims"},
			],
		},
	},
	// The recorded v1 review rows keep their own stage keys (#4977) and must still reach a grader.
	"review-code": {
		entry: {
			stage: "review-code",
			inputRef: 1199,
			label: {verdict: "PASS", acFindings: ["AC1 met"]},
		},
		passing: {verdict: "PASS", acFindings: ["AC1 met"]},
	},
	"review-doc": {
		entry: {
			stage: "review-doc",
			inputRef: 1850,
			label: {verdict: "FAIL", findings: ["broken link"]},
		},
		passing: {verdict: "FAIL", findings: ["broken link"]},
	},
	"ship-it": {
		entry: {
			stage: "ship-it",
			inputRef: 1851,
			label: {merged: true, mergeSha: "deadbee"},
		},
		passing: {merged: true, mergeSha: "deadbee"},
	},
} satisfies Record<string, {entry: CorpusEntry; passing: unknown}>;

const isFail = (g: Grade): g is Extract<Grade, {status: "fail"}> => g.status === "fail";

describe("gradeEntry — a matching artifact passes for every stage", () => {
	for (const [stage, {entry, passing}] of Object.entries(cases)) {
		it(`grades ${stage} pass when the artifact reproduces the label`, () => {
			assert.deepStrictEqual(gradeEntry(entry, passing), {status: "pass"});
		});
	}
});

describe("gradeEntry — a divergent artifact fails, carrying the observed-vs-expected mismatch", () => {
	it("triage: a changed classification fails with the diverged fields", () => {
		const g = gradeEntry(cases.triage.entry, {type: "bug", priority: "p0", status: "triaged"});
		assert.isTrue(isFail(g));
		if (isFail(g) && g.mismatch._tag === "LabelMismatch") {
			assert.deepStrictEqual(g.mismatch.fields, [
				{field: "type", observed: "bug", expected: "chore"},
				{field: "priority", observed: "p0", expected: "p1"},
			]);
		} else {
			assert.fail("expected a LabelMismatch");
		}
	});

	it("build: a lost review PASS fails with the reviewVerdict diff", () => {
		const g = gradeEntry(cases.build.entry, {
			fixesRef: 1848,
			ciGreen: true,
			reviewVerdict: "FAIL",
		});
		assert.isTrue(isFail(g));
		if (isFail(g) && g.mismatch._tag === "LabelMismatch") {
			assert.deepStrictEqual(g.mismatch.fields, [
				{field: "reviewVerdict", observed: "FAIL", expected: "PASS"},
			]);
		} else {
			assert.fail("expected a LabelMismatch");
		}
	});

	it("review/code: a dropped AC finding fails with the set diff", () => {
		const g = gradeEntry(cases["review/code"].entry, {
			verdict: "PASS",
			acFindings: ["AC1 met"],
		});
		assert.isTrue(isFail(g));
		if (isFail(g) && g.mismatch._tag === "LabelMismatch") {
			assert.deepStrictEqual(g.mismatch.fields, [
				{
					field: "acFindings",
					observed: JSON.stringify(["AC1 met"]),
					expected: JSON.stringify(["AC1 met", "AC2 met"]),
				},
			]);
		} else {
			assert.fail("expected a LabelMismatch");
		}
	});

	it("review/doc: a changed verdict fails with the verdict diff", () => {
		const g = gradeEntry(cases["review/doc"].entry, {verdict: "PASS", findings: ["broken link"]});
		assert.isTrue(isFail(g));
		if (isFail(g) && g.mismatch._tag === "LabelMismatch") {
			assert.deepStrictEqual(g.mismatch.fields, [
				{field: "verdict", observed: "PASS", expected: "FAIL"},
			]);
		} else {
			assert.fail("expected a LabelMismatch");
		}
	});

	it("review/skill: a finding refiled under another check fails with the set diff", () => {
		const g = gradeEntry(cases["review/skill"].entry, {
			verdict: "FAIL",
			rigorFindings: [
				// Same two findings, one re-attributed to the wrong rubric check.
				{check: "behavioral-correctness", finding: "description under-claims"},
				{check: "fabrika-conventions", finding: "restates a sibling's behavior"},
			],
		});
		assert.isTrue(isFail(g));
		if (isFail(g) && g.mismatch._tag === "LabelMismatch") {
			assert.deepStrictEqual(g.mismatch.fields, [
				{
					field: "rigorFindings",
					observed: JSON.stringify([
						"behavioral-correctness: description under-claims",
						"fabrika-conventions: restates a sibling's behavior",
					]),
					expected: JSON.stringify([
						"fabrika-conventions: restates a sibling's behavior",
						"trigger-description-quality: description under-claims",
					]),
				},
			]);
		} else {
			assert.fail("expected a LabelMismatch");
		}
	});

	it("ship-it: a different merge SHA fails with the mergeSha diff", () => {
		const g = gradeEntry(cases["ship-it"].entry, {merged: true, mergeSha: "cafef00"});
		assert.isTrue(isFail(g));
		if (isFail(g) && g.mismatch._tag === "LabelMismatch") {
			assert.deepStrictEqual(g.mismatch.fields, [
				{field: "mergeSha", observed: "cafef00", expected: "deadbee"},
			]);
		} else {
			assert.fail("expected a LabelMismatch");
		}
	});
});

describe("gradeEntry — total on a malformed or absent artifact (never throws)", () => {
	it("grades fail with a stated reason when the artifact is the wrong shape", () => {
		const g = gradeEntry(cases.triage.entry, {type: "chore" /* missing priority + status */});
		assert.isTrue(isFail(g));
		if (isFail(g)) {
			assert.strictEqual(g.mismatch._tag, "MalformedArtifact");
			if (g.mismatch._tag === "MalformedArtifact") {
				assert.match(g.mismatch.reason, /^triage artifact:/);
			}
		}
	});

	it("grades fail with a stated reason when the artifact is absent (undefined)", () => {
		const g = gradeEntry(cases["ship-it"].entry, undefined);
		assert.isTrue(isFail(g));
		if (isFail(g)) {
			assert.strictEqual(g.mismatch._tag, "MalformedArtifact");
		}
	});

	it("grades fail when an artifact carries an out-of-range verdict literal", () => {
		const g = gradeEntry(cases["review/code"].entry, {verdict: "MAYBE", acFindings: []});
		assert.isTrue(isFail(g));
		if (isFail(g)) {
			assert.strictEqual(g.mismatch._tag, "MalformedArtifact");
		}
	});
});

/**
 * ADR 0243 §2 bans dispatching a review grade on `stage` alone, because with one `review` key and
 * no second discriminator the three rubrics collapse onto one grader — silently, since a `doc`
 * artifact graded by the `code` rubric would just look like a fail. These assert the collapse did
 * not happen: each surface reaches its OWN grader and its own artifact schema.
 */
describe("gradeEntry — the three review surfaces do not share a grader", () => {
	it("a doc-shaped artifact under the code surface is malformed, not silently graded", () => {
		const g = gradeEntry(cases["review/code"].entry, {verdict: "PASS", findings: ["AC1 met"]});
		assert.isTrue(isFail(g));
		if (isFail(g)) {
			assert.strictEqual(g.mismatch._tag, "MalformedArtifact");
			if (g.mismatch._tag === "MalformedArtifact") {
				assert.match(g.mismatch.reason, /^review-code artifact:/);
			}
		}
	});

	it("a code-shaped artifact under the doc surface is malformed, not silently graded", () => {
		const g = gradeEntry(cases["review/doc"].entry, {verdict: "FAIL", acFindings: ["broken link"]});
		assert.isTrue(isFail(g));
		if (isFail(g)) {
			assert.strictEqual(g.mismatch._tag, "MalformedArtifact");
			if (g.mismatch._tag === "MalformedArtifact") {
				assert.match(g.mismatch.reason, /^review-doc artifact:/);
			}
		}
	});

	it("a doc-shaped artifact under the skill surface is malformed, not silently graded", () => {
		const g = gradeEntry(cases["review/skill"].entry, {verdict: "FAIL", findings: ["x"]});
		assert.isTrue(isFail(g));
		if (isFail(g)) {
			assert.strictEqual(g.mismatch._tag, "MalformedArtifact");
			if (g.mismatch._tag === "MalformedArtifact") {
				assert.match(g.mismatch.reason, /^review-skill artifact:/);
			}
		}
	});

	it("a rigor finding attributed to the governance check is malformed, never graded", () => {
		const g = gradeEntry(cases["review/skill"].entry, {
			verdict: "FAIL",
			rigorFindings: [{check: "gate-invariant-preservation", finding: "a guard was dropped"}],
		});
		assert.isTrue(isFail(g));
		if (isFail(g)) {
			assert.strictEqual(g.mismatch._tag, "MalformedArtifact");
		}
	});

	it("the same inputRef on two surfaces grades independently (a mixed-surface PR, ADR 0243 §3)", () => {
		const inputRef = 4979;
		const code: CorpusEntry = {
			stage: "review",
			surface: "code",
			inputRef,
			label: {verdict: "PASS", acFindings: ["AC1 met"]},
		};
		const doc: CorpusEntry = {
			stage: "review",
			surface: "doc",
			inputRef,
			label: {verdict: "FAIL", findings: ["broken link"]},
		};
		assert.deepStrictEqual(gradeEntry(code, {verdict: "PASS", acFindings: ["AC1 met"]}), {
			status: "pass",
		});
		assert.deepStrictEqual(gradeEntry(doc, {verdict: "FAIL", findings: ["broken link"]}), {
			status: "pass",
		});
	});
});
