import {describe, expect, it} from "vitest";
import {citationsOf, findDefects, type RegisterRows, renderFinding} from "./findings.ts";
import {parseRegister, type Row} from "./register.ts";

const rowsOf = (text: string): ReadonlyArray<Row> => {
	const parsed = parseRegister(text);
	if (parsed._tag !== "Parsed") throw new Error("fixture does not parse");
	return parsed.value.rows;
};

const terms = (text: string): RegisterRows => ({register: "terms", rows: rowsOf(text)});

const noCitations = {
	citations: new Map(),
	citationsUnverified: null,
	decisionsDir: ".decisions",
};

describe("citationsOf", () => {
	it("reads four-digit ids out of cells 2 and 3, never the term", () => {
		const row = rowsOf(`## S

| Term | Definition | Not |
|---|---|---|
| 0044 | Cites 0144. | see 0246 |
`)[0] as Row;
		expect(citationsOf(row)).toEqual(["0144", "0246"]);
	});
});

describe("findDefects", () => {
	it("reports a short row and an empty required cell, and never an empty Not cell", () => {
		const findings = findDefects({
			registers: [
				terms(`## S

| Term | Definition | Not |
|---|---|---|
| pano | The board. | |
| depo | |
| | x | |
`),
			],
			...noCitations,
		});
		expect(
			findings.filter((finding) => finding.kind === "row-shape").map((finding) => finding.detail),
		).toEqual(["expected 3 cells, found 2", "cell 1 is empty"]);
	});

	it("reports a duplicate key against the LATER row, naming the earlier section", () => {
		const findings = findDefects({
			registers: [
				terms(`## Core / shape

| Term | Definition | Not |
|---|---|---|
| pano | The board. | |

## Products (domains)

| Term | Definition | Not |
|---|---|---|
| pano | The board again. | |
`),
			],
			...noCitations,
		});
		expect(findings).toEqual([
			{
				kind: "duplicate-key",
				register: "terms",
				section: "Products (domains)",
				term: "pano",
				detail: 'also declared in "Core / shape"',
			},
		]);
	});

	// One term, one register, one row (#4465).
	it("reports a key declared in both registers as cross-register", () => {
		const table = `## S

| Term | Definition | Not |
|---|---|---|
| seam | A boundary. | |
`;
		const findings = findDefects({
			registers: [terms(table), {register: "language", rows: rowsOf(table)}],
			...noCitations,
		});
		expect(findings.map((finding) => finding.kind)).toEqual(["cross-register"]);
		expect(findings[0]?.detail).toBe('also declared in terms under "S"');
	});

	it("reports a row that sorts before the row above it, within its section", () => {
		const findings = findDefects({
			registers: [
				terms(`## S

| Term | Definition | Not |
|---|---|---|
| sozluk | x | |
| depo | y | |
`),
			],
			...noCitations,
		});
		expect(findings[0]).toMatchObject({kind: "out-of-order", detail: 'sorts before "sozluk"'});
	});

	it("separates a citation with no record from one whose record is not live", () => {
		const findings = findDefects({
			registers: [
				terms(`## S

| Term | Definition | Not |
|---|---|---|
| depo | Cites 0044 and 9999. | |
`),
			],
			citations: new Map([
				["0044", {_tag: "Superseded" as const, status: "superseded by [0144](0144-x.md)"}],
				["9999", {_tag: "Dead" as const}],
			]),
			citationsUnverified: null,
			decisionsDir: ".decisions",
		});
		expect(findings.map((finding) => finding.detail)).toEqual([
			"cites 9999, no record under .decisions",
			'cites 0044, status "superseded by [0144](0144-x.md)"',
		]);
	});

	it("reports an unresolved decision corpus rather than reporting clean over it", () => {
		const findings = findDefects({
			registers: [
				terms(`## S

| Term | Definition | Not |
|---|---|---|
| depo | Cites 0044. | |
`),
			],
			citations: new Map(),
			citationsUnverified: "ENOENT",
			decisionsDir: ".decisions",
		});
		expect(findings).toEqual([
			{
				kind: "citations-unverified",
				register: "-",
				section: "-",
				term: "-",
				detail: "cannot read .decisions: ENOENT",
			},
		]);
	});

	it("finds nothing in a clean register", () => {
		expect(
			findDefects({
				registers: [
					terms(`## S

| Term | Definition | Not |
|---|---|---|
| depo | The internal asset store. | |
| pano | The board product. | |
`),
				],
				...noCitations,
			}),
		).toEqual([]);
	});
});

describe("renderFinding", () => {
	it("is five tab-separated columns", () => {
		expect(
			renderFinding({
				kind: "duplicate-key",
				register: "terms",
				section: "Products (domains)",
				term: "pano",
				detail: 'also declared in "Core / shape"',
			}),
		).toBe('duplicate-key\tterms\tProducts (domains)\tpano\talso declared in "Core / shape"');
	});
});
