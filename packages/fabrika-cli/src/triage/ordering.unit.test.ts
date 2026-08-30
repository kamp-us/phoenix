import {describe, expect, it} from "vitest";
import {statedOrderings, unwiredReferences} from "./ordering.ts";

const numbers = (text: string) => statedOrderings(text).flatMap((o) => o.references);

describe("statedOrderings — what counts as a statement", () => {
	it.each([
		["**Blocked. Do not start until #6662 has merged** — it adds the invalidate arm.", [6662]],
		["This one is blocked by #6661 until the pin moves.", [6661]],
		["Depends on #4311, which ships the helper.", [4311]],
		["It is dependent on #4311.", [4311]],
		["Order is #6661 → #6662 → #6663.", [6661, 6662, 6663]],
		["Do not start before #900.", [900]],
		["Blocked on issue #12.", [12]],
	])("reads %j as an ordering", (line, expected) => {
		expect(numbers(line)).toEqual(expected);
	});

	/**
	 * The co-presence rule these replace matched every one of these, and #6728's own body carries two
	 * of them. A red none of them can clear by wiring an edge is a red with only the reword escape,
	 * on a body that is already correct.
	 */
	it.each([
		["a keyword and a reference that do not bind", "Searched for blocked work. #6734 is a defect."],
		["a mention of the ordering vocabulary alone", "The graph is the carrier of orderings."],
		["a reference with no ordering phrase", "See #6661 and #6662 for the slice set."],
		["a quoted ordering", 'Its body says verbatim "**Blocked. Do not start until #6662**".'],
		["an ordering inside inline code", "The line `blocked by #6662` is what shipped as prose."],
		["a blockquote", "> Blocked. Do not start until #6662 has merged."],
	])("does not read %s as one", (_case, line) => {
		expect(statedOrderings(line)).toEqual([]);
	});

	it("ignores a fenced ordering — a transcript is not a statement", () => {
		const body = "Verified live:\n\n```\nbuild eligible 6663 → blocked by #6662.\n```\n\nDone.";
		expect(statedOrderings(body)).toEqual([]);
	});

	it("ignores an ordering inside a `<details>` block — the preserved original", () => {
		const body = [
			"The rewrite states nothing.",
			"",
			"<!-- fabrika:enriched issue=6663 mode=rewrite -->",
			"<details>",
			"<summary>Original report (verbatim)</summary>",
			"",
			"Blocked. Do not start until #6662 has merged.",
			"",
			"</details>",
		].join("\n");
		expect(statedOrderings(body)).toEqual([]);
	});

	it("names only the phrase's own sentence, not every reference on the line", () => {
		expect(numbers("Unlike #6734, this depends on #6661. Separately, #6722 is open.")).toEqual([
			6661,
		]);
	});

	it("reports the line number and the line as written, quotations intact", () => {
		const found = statedOrderings("intro\n\nBlocked by #6661 for now.\n");
		expect(found).toEqual([{line: 3, text: "Blocked by #6661 for now.", references: [6661]}]);
	});

	it("deduplicates a number the same statement names twice", () => {
		expect(numbers("Blocked by #6661 — yes, #6661.")).toEqual([6661]);
	});
});

/**
 * The gate's own issue, whose authored region is the hardest available case: it is *about*
 * orderings, quotes the incident's sentence, and lists the slice set — while owning no prerequisite
 * itself (#6728 carries no `blocked_by` edge). Every line here is verbatim from that body.
 */
describe("the self-check on #6728", () => {
	it("finds no stated ordering in the issue that specified this gate", () => {
		const authored = [
			"prose instead. That is how 6661 → 6662 → 6663 shipped as a sentence.",
			"",
			"1. **Offer only** — a repeatable `--blocked-by <n>` on `triage apply` (or a new `triage link`),",
			"",
			'verbatim "**Blocked. Do not start until #6662 has merged**". The lane spent a claim, a read pass and',
			"",
			"Searched the queue and open issues for ordering/edge/blocked work. #6734, #6730, #6722 and #6715 are",
			"",
			"- #6661, #6662, #6663 — the slice set; edges now wired",
		].join("\n");
		expect(statedOrderings(authored)).toEqual([]);
	});
});

describe("unwiredReferences", () => {
	const ordering = statedOrderings("Order is #6661 → #6662 → #6663.");

	it("reports only the numbers the live graph does not carry", () => {
		expect(unwiredReferences(ordering, [6661]).flatMap((o) => o.references)).toEqual([6662, 6663]);
	});

	it("reports nothing when every number is wired", () => {
		expect(unwiredReferences(ordering, [6661, 6662, 6663, 9999])).toEqual([]);
	});

	it("reports everything when the graph is empty", () => {
		expect(unwiredReferences(ordering, []).flatMap((o) => o.references)).toEqual([
			6661, 6662, 6663,
		]);
	});
});
