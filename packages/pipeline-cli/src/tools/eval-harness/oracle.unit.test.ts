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
	"write-code": {
		entry: {
			stage: "write-code",
			inputRef: 1848,
			label: {fixesRef: 1848, ciGreen: true, reviewVerdict: "PASS"},
		},
		passing: {fixesRef: 1848, ciGreen: true, reviewVerdict: "PASS"},
	},
	"review-code": {
		entry: {
			stage: "review-code",
			inputRef: 1849,
			label: {verdict: "PASS", acFindings: ["AC1 met", "AC2 met"]},
		},
		passing: {verdict: "PASS", acFindings: ["AC2 met", "AC1 met"]}, // set-equal, reordered
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

	it("write-code: a lost review PASS fails with the reviewVerdict diff", () => {
		const g = gradeEntry(cases["write-code"].entry, {
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

	it("review-code: a dropped AC finding fails with the set diff", () => {
		const g = gradeEntry(cases["review-code"].entry, {
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

	it("review-doc: a changed verdict fails with the verdict diff", () => {
		const g = gradeEntry(cases["review-doc"].entry, {verdict: "PASS", findings: ["broken link"]});
		assert.isTrue(isFail(g));
		if (isFail(g) && g.mismatch._tag === "LabelMismatch") {
			assert.deepStrictEqual(g.mismatch.fields, [
				{field: "verdict", observed: "PASS", expected: "FAIL"},
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
		const g = gradeEntry(cases["review-code"].entry, {verdict: "MAYBE", acFindings: []});
		assert.isTrue(isFail(g));
		if (isFail(g)) {
			assert.strictEqual(g.mismatch._tag, "MalformedArtifact");
		}
	});
});
