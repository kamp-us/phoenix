import {describe, expect, it} from "vitest";
import {read as readCriteria} from "../wire/acceptance-criteria.ts";
import {
	appendOnly,
	criterionRow,
	grewByOne,
	insertAfterLastCriterion,
	provenanceTag,
} from "./append.ts";

/** The criteria the registered format reads out of a body — the operand `grewByOne` compares. */
const criteriaOf = (body: string) => {
	const block = readCriteria(body);
	return block._tag === "Found" ? block.value : null;
};

const BODY = `### Acceptance criteria

- [x] the first thing
- [ ] the second thing

Some trailing prose.`;

describe("criterionRow", () => {
	it("carries the provenance tag that makes a routed row auditable", () => {
		expect(criterionRow("a regression test covers qty > 1", 4321, 1)).toBe(
			"- [ ] a regression test covers qty > 1 <!-- ac:review pr:#4321 round:1 -->",
		);
		expect(provenanceTag(4321, 2)).toBe("<!-- ac:review pr:#4321 round:2 -->");
	});
});

describe("insertAfterLastCriterion", () => {
	it("puts the row inside the block a later read parses, not after the trailing prose", () => {
		const composed = insertAfterLastCriterion(BODY, "the second thing", "- [ ] a third thing");
		expect(composed).toBe(`### Acceptance criteria

- [x] the first thing
- [ ] the second thing
- [ ] a third thing

Some trailing prose.`);
	});

	it("anchors on the block's last criterion, not on the last checkbox anywhere in the body", () => {
		const withLaterList = `### Acceptance criteria

- [ ] the only criterion

## Notes

- [ ] a checkbox that is not a criterion`;
		const composed =
			insertAfterLastCriterion(withLaterList, "the only criterion", "- [ ] added") ?? "";
		expect(composed.indexOf("- [ ] added")).toBeLessThan(composed.indexOf("## Notes"));
	});

	it("answers null when the criterion's line cannot be located", () => {
		expect(insertAfterLastCriterion(BODY, "a row that is not there", "- [ ] x")).toBeNull();
	});
});

describe("grewByOne", () => {
	it("passes the block the parser reads back as the old rows plus this one", () => {
		const composed =
			insertAfterLastCriterion(BODY, "the second thing", "- [ ] a third thing") ?? "";
		expect(grewByOne(criteriaOf(BODY) ?? [], criteriaOf(composed), "a third thing")).toBe(true);
	});

	it("reds on a row inserted where the FORMAT cannot see it, which appendOnly cannot catch", () => {
		// The old bytes are untouched and exactly one line was added, so the line-level guard passes —
		// and the criterion enters no contract at all, because it landed under the next heading. This
		// is the half the second guard exists for.
		const withLaterSection = `${BODY}\n\n## Notes\n\nnothing yet.`;
		const past = `${withLaterSection}\n- [ ] a third thing`;
		expect(appendOnly(withLaterSection, past)._tag).toBe("AppendOnly");
		expect(grewByOne(criteriaOf(withLaterSection) ?? [], criteriaOf(past), "a third thing")).toBe(
			false,
		);
	});

	it("reds when a prior row changed, and when the added row is not the text that was written", () => {
		const mutated = criteriaOf(`### Acceptance criteria

- [x] the first thing
- [x] the second thing
- [ ] a third thing`);
		expect(grewByOne(criteriaOf(BODY) ?? [], mutated, "a third thing")).toBe(false);
		const composed =
			insertAfterLastCriterion(BODY, "the second thing", "- [ ] something else") ?? "";
		expect(grewByOne(criteriaOf(BODY) ?? [], criteriaOf(composed), "a third thing")).toBe(false);
	});
});

describe("appendOnly", () => {
	it("passes exactly one inserted line", () => {
		const composed =
			insertAfterLastCriterion(BODY, "the second thing", "- [ ] a third thing") ?? "";
		expect(appendOnly(BODY, composed)._tag).toBe("AppendOnly");
	});

	it("refuses a body that dropped a prior row, even at the right length", () => {
		const mutilated = `### Acceptance criteria

- [x] the first thing
- [ ] a third thing
- [ ] a fourth thing

Some trailing prose.`;
		expect(appendOnly(BODY, mutilated)._tag).toBe("Violates");
	});

	it("refuses a body that MUTATED a prior row while adding one", () => {
		const mutated = `### Acceptance criteria

- [x] the first thing
- [x] the second thing
- [ ] a third thing

Some trailing prose.`;
		expect(appendOnly(BODY, mutated)._tag).toBe("Violates");
	});

	it("refuses two added lines — the fence is exactly one row", () => {
		const two = `${BODY}\n- [ ] a\n- [ ] b`;
		expect(appendOnly(BODY, two)._tag).toBe("Violates");
	});

	it("refuses a shorter body outright", () => {
		expect(appendOnly(BODY, "### Acceptance criteria")._tag).toBe("Violates");
	});
});
