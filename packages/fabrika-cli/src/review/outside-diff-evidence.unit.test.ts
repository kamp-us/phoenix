/**
 * The grading rule for a criterion whose evidence lives outside the diff.
 *
 * The pair that carries the design is the first two cases: the *same* marked criterion grades `Pass`
 * against a verdict body that cites its evidence and `Fail` against one that does not, and the
 * `Fail` quotes both the criterion and the source it pointed at. Before the marker existed there was
 * one arm — FAIL — and it fired on a criterion no diff could ever discharge, three times running on
 * byte-identical input.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9200
 */
import {describe, expect, it} from "vitest";
import {
	type AcceptanceCriterion,
	criterionText,
	evidenceSource,
} from "../wire/acceptance-criteria.ts";
import {gradeEvidence, marked, namesEvidence, quoteRows} from "./outside-diff-evidence.ts";

const criterion = (text: string, evidence?: string): AcceptanceCriterion => {
	const value = criterionText(text);
	if (value === null) throw new Error(`"${text}" is not criterion text`);
	const source = evidence === undefined ? null : evidenceSource(evidence);
	if (evidence !== undefined && source === null) {
		throw new Error(`"${evidence}" is not an evidence source`);
	}
	return {text: value, checked: false, evidence: source};
};

const CHECKPOINT = criterion(
	"a desk checkpointed under the old stored-id shape comes back whole",
	"hand-verification on a real desk",
);
const PAINTS = criterion("the transcript reader paints on first mount");

describe("gradeEvidence", () => {
	it("passes a marked criterion whose evidence the verdict body names", () => {
		const grade = gradeEvidence(
			[CHECKPOINT, PAINTS],
			"AC 1 rests on hand-verification on a real desk, recorded in the PR body. AC 2 is in the diff.",
		);
		expect(grade._tag).toBe("Pass");
		if (grade._tag !== "Pass") return;
		expect(grade.named).toEqual([{text: CHECKPOINT.text, evidence: CHECKPOINT.evidence}]);
	});

	it("fails a marked criterion whose evidence the verdict body names nowhere, and quotes it", () => {
		const grade = gradeEvidence([CHECKPOINT, PAINTS], "Every criterion is discharged by the diff.");
		expect(grade._tag).toBe("Fail");
		if (grade._tag !== "Fail") return;
		expect(grade.missing).toEqual([{text: CHECKPOINT.text, evidence: CHECKPOINT.evidence}]);
		expect(quoteRows(grade.missing)).toBe(
			'  - "a desk checkpointed under the old stored-id shape comes back whole" — evidence: hand-verification on a real desk',
		);
	});

	it("passes a contract with no marked criterion — the unmarked rows keep today's rule", () => {
		expect(gradeEvidence([PAINTS], "The diff discharges it.")).toEqual({_tag: "Pass", named: []});
	});

	it("names only the marked rows, in contract order", () => {
		expect(marked([PAINTS, CHECKPOINT])).toEqual([
			{text: CHECKPOINT.text, evidence: CHECKPOINT.evidence},
		]);
	});
});

describe("namesEvidence", () => {
	it("matches across a line break and a case difference — neither is a fact about the evidence", () => {
		expect(
			namesEvidence(
				"AC 1 rests on Hand-verification\non a real desk.",
				"hand-verification on a real desk",
			),
		).toBe(true);
	});

	it("does not match a body that cites some other evidence", () => {
		expect(namesEvidence("AC 1 rests on the CI log.", "hand-verification on a real desk")).toBe(
			false,
		);
	});
});
