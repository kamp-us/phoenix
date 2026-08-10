import {describe, expect, it} from "vitest";
import {
	cellText,
	composeRow,
	isDelimiterRow,
	linkTarget,
	memberName,
	parseIndex,
	rowCells,
	tableSections,
} from "./index-table.ts";

const INDEX = `# Patterns

A three-section index fixture.

## Index — services

| Doc | Topic | Read when |
|---|---|---|
| [cache-invalidation.md](./cache-invalidation.md) | Cache keys | Touching a cached read |

## Index — edge

| Doc | Topic | Read when |
|---|---|---|
| [edge-session-cookies.md](./edge-session-cookies.md) | Session cookies | Changing session handling |

## Index — observability

| Doc | Topic | Read when |
|---|---|---|
| [tracing-span-names.md](./tracing-span-names.md) | Span naming | Naming a new span |
`;

describe("rowCells", () => {
	it("splits a row and unescapes its pipes", () => {
		expect(rowCells("| a | b\\|c | d |")).toEqual(["a", "b|c", "d"]);
	});

	it("is null for a line that is not a row", () => {
		expect(rowCells("just prose")).toBeNull();
		expect(rowCells("## Index — services")).toBeNull();
	});
});

describe("isDelimiterRow", () => {
	it("recognises the alignment forms", () => {
		for (const line of ["|---|---|", "| --- | :---: |", "|:---|---:|"]) {
			expect(isDelimiterRow(line)).toBe(true);
		}
	});

	it("is false for a content row", () => {
		expect(isDelimiterRow("| [a.md](./a.md) | x | y |")).toBe(false);
	});
});

describe("memberName", () => {
	it("reads a bare or dot-slash target as a member", () => {
		expect(memberName("./cache-invalidation.md")).toBe("cache-invalidation.md");
		expect(memberName("cache-invalidation.md")).toBe("cache-invalidation.md");
	});

	// A target that resolves perfectly well — an ADR, a doc in a subdirectory — is still not a MEMBER
	// of this corpus. The question is membership, not reachability, which is why this is not a link
	// check and does not overlap the link gate.
	it("is null for anything carrying a directory component or a scheme", () => {
		for (const target of [
			"../.decisions/0001-x.md",
			"sub/foo.md",
			"https://example.com/a.md",
			"",
		]) {
			expect(memberName(target)).toBeNull();
		}
	});
});

describe("linkTarget", () => {
	it("reads the first markdown link's target", () => {
		expect(linkTarget("[a.md](./a.md)")).toBe("./a.md");
	});

	it("is null when the cell links nothing — a header cell is not a registration", () => {
		expect(linkTarget("Doc")).toBeNull();
	});
});

describe("parseIndex", () => {
	const index = parseIndex(INDEX);

	it("names every section carrying a table, in document order", () => {
		expect(tableSections(index)).toEqual([
			"Index — services",
			"Index — edge",
			"Index — observability",
		]);
	});

	it("binds each content row to its enclosing heading", () => {
		expect(index.rows.filter((r) => r.member !== null).map((r) => [r.member, r.section])).toEqual([
			["cache-invalidation.md", "Index — services"],
			["edge-session-cookies.md", "Index — edge"],
			["tracing-span-names.md", "Index — observability"],
		]);
	});

	// v1's check was `grep -n "$NAME.md" index.md`: unanchored, whole-file, and with `.` as a regex
	// any-char, so a mention in prose passed as a row. Registration is a table row's FIRST cell.
	it("does not read a prose mention, or a second cell, as a registration", () => {
		const parsed = parseIndex(`## Index — services

See worker-queue-retry.md for the retry shape.

| Doc | Topic | Read when |
|---|---|---|
| [a.md](./a.md) | see [worker-queue-retry.md](./worker-queue-retry.md) | x |
`);
		expect(parsed.rows.map((r) => r.member)).toEqual([null, "a.md"]);
	});

	it("reports no table for a document that holds none", () => {
		expect(parseIndex("# Patterns\n\nNothing here yet.\n").hasTable).toBe(false);
	});
});

describe("composeRow", () => {
	it("escapes pipes and flattens tabs so one row stays one line", () => {
		expect(composeRow("a-b", "x | y", "line\tone")).toBe(
			"| [a-b.md](./a-b.md) | x \\| y | line one |",
		);
	});

	it("round-trips through the parser it is written for", () => {
		const row = composeRow("a-b", "topic", "read when");
		expect(rowCells(row)).toEqual(["[a-b.md](./a-b.md)", "topic", "read when"]);
	});
});

describe("cellText", () => {
	it("strips newlines as well as tabs", () => {
		expect(cellText("a\nb")).toBe("a b");
	});
});
