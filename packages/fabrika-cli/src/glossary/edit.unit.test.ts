import {describe, expect, it} from "vitest";
import {appendIndex, linesChangedBeyond, newSectionBlock, placeRow} from "./edit.ts";
import {parseRegister, type Section} from "./register.ts";

const register = `# fixture

## Products

| Term | Definition | Not |
|---|---|---|
| depo | The internal asset store. | |
| pano | The board product. | |
| sozluk | The dictionary product. | |
`;

const sectionOf = (text: string, name: string): Section => {
	const parsed = parseRegister(text);
	if (parsed._tag !== "Parsed") throw new Error("fixture does not parse");
	const found = parsed.value.sections.find((section) => section.name === name);
	if (found === undefined) throw new Error(`no section ${name}`);
	return found;
};

describe("placeRow", () => {
	const products = sectionOf(register, "Products");

	it("places a key before the first row that sorts after it", () => {
		expect(placeRow(products, "capture ledger").index).toBe(6);
	});

	it("places a key that sorts last one past the final row", () => {
		expect(placeRow(products, "worker").index).toBe(9);
	});

	it("reports a sorted section as sorted", () => {
		expect(placeRow(products, "capture ledger").unsorted).toBe(false);
	});

	it("names an unsorted section and still places the row against its neighbours", () => {
		const unsorted = sectionOf(
			`## Products

| Term | Definition | Not |
|---|---|---|
| sozluk | x | |
| depo | y | |
`,
			"Products",
		);
		const placement = placeRow(unsorted, "pano");
		expect(placement.unsorted).toBe(true);
		// The first slot that holds against its neighbours — `pano` sorts before `sozluk`, and the
		// rows below it are left exactly where they were.
		expect(placement.index).toBe(4);
	});

	it("places the first row of a table that has a header and no rows yet", () => {
		const empty = sectionOf(
			`## Products

| Term | Definition | Not |
|---|---|---|
`,
			"Products",
		);
		expect(placeRow(empty, "depo").index).toBe(4);
	});
});

describe("linesChangedBeyond", () => {
	const before = register.split("\n");

	it("is 0 for a single inserted row", () => {
		const after = [...before.slice(0, 6), "| capture ledger | x | |", ...before.slice(6)];
		expect(linesChangedBeyond(before, after, {at: 6, added: 1, replaced: 0})).toBe(0);
	});

	it("is 0 for a single rewritten row", () => {
		const after = [...before];
		after[7] = "| pano | The board product, redefined. | |";
		expect(linesChangedBeyond(before, after, {at: 7, added: 1, replaced: 1})).toBe(0);
	});

	it("is 0 for the five lines --create-section appends", () => {
		const at = appendIndex(before);
		const block = newSectionBlock("Indexing", "| tag | x | |");
		const after = [...before.slice(0, at), ...block, ...before.slice(at)];
		expect(linesChangedBeyond(before, after, {at, added: block.length, replaced: 0})).toBe(0);
	});

	/**
	 * The defect the assertion exists to abort: a write that also re-sorts the section it touched. It
	 * is what makes "change only the affected rows" a mechanism rather than a hope.
	 */
	it("counts every line a re-sort moved, which is what aborts the write on 15", () => {
		const after = [
			...before.slice(0, 6),
			"| capture ledger | x | |",
			"| sozluk | The dictionary product. | |",
			"| pano | The board product. | |",
			"| depo | The internal asset store. | |",
			...before.slice(9),
		];
		expect(linesChangedBeyond(before, after, {at: 6, added: 1, replaced: 0})).toBeGreaterThan(0);
	});

	it("counts a trailing truncation the splice did not ask for", () => {
		const after = [...before.slice(0, 6), "| capture ledger | x | |", ...before.slice(6, -2)];
		expect(linesChangedBeyond(before, after, {at: 6, added: 1, replaced: 0})).toBeGreaterThan(0);
	});
});

describe("appendIndex", () => {
	it("appends before the empty element a trailing newline splits into", () => {
		expect(appendIndex(["a", "b", ""])).toBe(2);
		expect(appendIndex(["a", "b"])).toBe(2);
	});
});
