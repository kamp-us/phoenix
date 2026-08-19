/**
 * The ADR number-lock rule — the duplicate-id and number-mismatch cases from `pipeline-cli`'s
 * `decisions-index.unit.test.ts`, re-seated on a defect list instead of a thrown error.
 */
import {describe, expect, it} from "vitest";
import {type DecisionFile, findDefects} from "./decisions-number.ts";

const record = (file: string, fields: Readonly<Record<string, string>>): DecisionFile => ({
	file,
	text: `---\n${Object.entries(fields)
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n")}\n---\n\nbody\n`,
});

const complete = (id: string) => ({id, title: "A title", status: "accepted", date: "2026-08-18"});

describe("findDefects", () => {
	it("finds nothing in a well-formed corpus", () => {
		expect(
			findDefects([record("0001-a.md", complete("0001")), record("0002-b.md", complete("0002"))]),
		).toEqual([]);
	});

	// The #1471 class: two branches each mint the same number, each green alone.
	it("names both files of a duplicate id", () => {
		expect(
			findDefects([record("0284-a.md", complete("0284")), record("0284-b.md", complete("0284"))]),
		).toEqual([{_tag: "DuplicateId", id: "0284", files: ["0284-a.md", "0284-b.md"]}]);
	});

	it("reds a filename number that disagrees with the frontmatter id", () => {
		expect(findDefects([record("0284-a.md", complete("0285"))])).toEqual([
			{_tag: "NumberMismatch", file: "0284-a.md", filePrefix: "0284", id: "0285"},
		]);
	});

	it.each(["id", "title", "status", "date"])("reds a missing %s field", (field) => {
		const fields = {...complete("0001")} as Record<string, string>;
		delete fields[field];
		expect(findDefects([record("0001-a.md", fields)])).toContainEqual({
			_tag: "MissingField",
			file: "0001-a.md",
			field,
		});
	});

	it("reds an empty field the same as an absent one", () => {
		expect(findDefects([record("0001-a.md", {...complete("0001"), title: ""})])).toContainEqual({
			_tag: "MissingField",
			file: "0001-a.md",
			field: "title",
		});
	});

	// A lettered variant shares its base number and is a record in its own right, so it must not
	// collide with the record it varies.
	it("does not read a lettered variant as a duplicate of its base", () => {
		expect(
			findDefects([record("0034-a.md", complete("0034")), record("0034a-b.md", complete("0034a"))]),
		).toEqual([]);
	});

	// A mismatched record contributes no id, so it cannot manufacture a phantom collision on top
	// of the real defect it already has.
	it("does not let a mismatched file collide with the id it wrongly claims", () => {
		const defects = findDefects([
			record("0284-a.md", complete("0284")),
			record("0285-b.md", complete("0284")),
		]);
		expect(defects).toEqual([
			{_tag: "NumberMismatch", file: "0285-b.md", filePrefix: "0285", id: "0284"},
		]);
	});

	it("orders duplicates by number", () => {
		const defects = findDefects([
			record("0300-a.md", complete("0300")),
			record("0300-b.md", complete("0300")),
			record("0100-c.md", complete("0100")),
			record("0100-d.md", complete("0100")),
		]);
		expect(defects.map((d) => (d._tag === "DuplicateId" ? d.id : ""))).toEqual(["0100", "0300"]);
	});
});
