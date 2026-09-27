import {describe, expect, it} from "vitest";
import type {StandingRuling} from "../decision/ruling.ts";
import {read as readCriteria} from "../wire/acceptance-criteria.ts";
import {criterionIndex, markedIssue, rulingUrl, scopeDigest} from "../wire/decision-ruling.ts";
import {markerTime} from "../wire/grill-marker.ts";
import {gradedSet, type RulingText, renderGradedSet} from "./graded-set.ts";

/** The placeholder repository the fixtures speak, held in a constant rather than written inline. */
const REPO = "o/r";
const rulingCommentUrl = (comment: number): string =>
	`https://github.com/${REPO}/issues/9508#issuecomment-${comment}`;

const BODY = [
	"### Acceptance criteria",
	"",
	"- [ ] the first retry delay equals `base`",
	"- [x] the retry guide documents the delay table",
	"- [ ] the builder may judge the inline question for itself",
	"",
].join("\n");

const criteriaOf = (body: string) => {
	const block = readCriteria(body);
	if (block._tag !== "Found") throw new Error(`the fixture block reads ${block._tag}`);
	return block.value;
};

const ruling = (comment: number, at: string, supersedes: number | null = null): StandingRuling => ({
	by: "founder",
	comment,
	ruling: {
		issue: markedIssue(9508) ?? (0 as never),
		digest: scopeDigest("4d90e1bb27ac") ?? ("" as never),
		ruling: rulingUrl(rulingCommentUrl(comment)) ?? ("" as never),
		supersedes: supersedes === null ? null : (criterionIndex(supersedes) ?? (0 as never)),
		at: markerTime(at) ?? ("" as never),
	},
});

const withText = (standing: StandingRuling, text: string | null): RulingText => ({
	ruling: standing,
	text,
});

describe("gradedSet", () => {
	it("is today's answer unchanged when no ruling stands", () => {
		const set = gradedSet(criteriaOf(BODY), []);
		expect(set.rulings).toBe(0);
		expect(set.superseded).toBe(0);
		expect(set.rows.map((row) => [row.source, row.state])).toEqual([
			["body", "open"],
			["body", "checked"],
			["body", "open"],
		]);
	});

	it("folds a standing ruling in as its own row, carrying the founder's words", () => {
		const set = gradedSet(criteriaOf(BODY), [
			withText(
				ruling(1, "2026-09-20T10:00:00Z"),
				"No inline decision logic in\nthe workflow yaml.",
			),
		]);
		expect(set.rulings).toBe(1);
		expect(set.rows).toHaveLength(4);
		expect(set.rows[3]).toMatchObject({
			source: "ruling",
			state: "open",
			text: "No inline decision logic in the workflow yaml.",
			supersedes: null,
		});
	});

	/**
	 * The real case: three rulings on one issue, the third reversing the second. All three are rows,
	 * oldest first, so a reader can see the reversal rather than being handed only the survivor.
	 */
	it("keeps every standing ruling, in the order they were made", () => {
		const set = gradedSet(criteriaOf(BODY), [
			withText(ruling(1, "2026-09-20T10:00:00Z"), "A unit-tested decision core."),
			withText(ruling(2, "2026-09-20T11:00:00Z"), "The core lives in packages/ci-cli."),
			withText(ruling(3, "2026-09-20T12:00:00Z"), "Reversed: no new package."),
		]);
		expect(set.rows.filter((row) => row.source === "ruling").map((row) => row.at)).toEqual([
			"2026-09-20T10:00:00Z",
			"2026-09-20T11:00:00Z",
			"2026-09-20T12:00:00Z",
		]);
	});

	it("reports the body criterion a ruling supersedes, and never drops it", () => {
		const set = gradedSet(criteriaOf(BODY), [
			withText(ruling(1, "2026-09-20T10:00:00Z", 3), "The inline question is closed."),
		]);
		expect(set.superseded).toBe(1);
		expect(set.rows).toHaveLength(4);
		expect(set.rows[2]).toMatchObject({
			source: "body",
			state: "superseded",
			text: "the builder may judge the inline question for itself",
		});
	});

	it("counts a supersedes naming a row the block does not have, rather than dropping it", () => {
		const set = gradedSet(criteriaOf(BODY), [
			withText(ruling(1, "2026-09-20T10:00:00Z", 9), "Closed."),
		]);
		expect(set.danglingSupersedes).toEqual([9]);
		expect(set.superseded).toBe(0);
		expect(set.rows.filter((row) => row.state === "superseded")).toHaveLength(0);
	});

	it("falls back to the ruling's URL when the cited comment is not in hand", () => {
		const set = gradedSet(criteriaOf(BODY), [withText(ruling(4, "2026-09-20T10:00:00Z"), null)]);
		expect(set.rows[3]?.text).toBe(rulingCommentUrl(4));
	});
});

describe("renderGradedSet", () => {
	it("names each row's source, then its state, then what it says", () => {
		const set = gradedSet(criteriaOf(BODY), [
			withText(ruling(1, "2026-09-20T10:00:00Z", 3), "The inline question is closed."),
		]);
		expect(renderGradedSet(set)).toEqual([
			"body\topen\tthe first retry delay equals `base`",
			"body\tchecked\tthe retry guide documents the delay table",
			"body\tsuperseded\tthe builder may judge the inline question for itself",
			`ruling\topen\tThe inline question is closed.\t${rulingCommentUrl(1)}`,
		]);
	});
});
