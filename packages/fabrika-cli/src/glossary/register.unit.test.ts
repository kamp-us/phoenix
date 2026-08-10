import {describe, expect, it} from "vitest";
import {
	normalizeCell,
	normalizeKey,
	overlaps,
	parseRegister,
	renderRow,
	splitCells,
} from "./register.ts";

const fixture = `# fixture domain vocabulary (TERMS)

Prose that mentions #3227). as a bare hash, which is not a heading.

## Core / shape

| Term | Definition | Not |
|---|---|---|
| pano | The board product. | |
| worker | The edge worker. Cites 0044. | "server" |

## Indexing

| Term | Definition | Not |
|---|---|---|
| Database (tag) | The row-version marker. | a user-applied label |
`;

describe("normalizeKey", () => {
	it("folds case with a Unicode-aware lowercase, so Turkish nouns are not dropped (#4481)", () => {
		expect(normalizeKey("Sözlük")).toBe("sözlük");
		expect(normalizeKey("Geçit")).toBe("geçit");
	});

	it("folds hyphens, underscores and whitespace runs to one space", () => {
		expect(normalizeKey("front-door")).toBe("front door");
		expect(normalizeKey("front_door")).toBe("front door");
		expect(normalizeKey("  front   door  ")).toBe("front door");
	});

	it("strips a surrounding run of backticks, asterisks and underscores", () => {
		expect(normalizeKey("`depo`")).toBe("depo");
		expect(normalizeKey("**depo**")).toBe("depo");
	});

	// The v1 alias-splitting produced three false duplicates; a parenthetical is a qualifier (#4206).
	it("keeps the whole cell as one key — no split on a parenthesis, slash or comma", () => {
		expect(normalizeKey("Database (tag)")).toBe("database (tag)");
		expect(normalizeKey("sözlük (sozluk)")).toBe("sözlük (sozluk)");
		expect(normalizeKey("Database (tag)")).not.toBe(normalizeKey("tag"));
	});
});

describe("overlaps", () => {
	it("matches a whole-word span in either direction", () => {
		expect(overlaps("front door detection", "front door")).toBe(true);
		expect(overlaps("front door", "front door detection")).toBe(true);
		expect(overlaps("database (tag)", "tag")).toBe(true);
	});

	it("does not match a span that begins or ends mid-word", () => {
		expect(overlaps("storefront doorway", "front door")).toBe(false);
	});

	it("is false for equal keys — that is `declared`, not a collision", () => {
		expect(overlaps("pano", "pano")).toBe(false);
	});
});

describe("splitCells", () => {
	it("splits on unescaped pipes and unescapes the rest", () => {
		expect(splitCells("| a | b\\|c | |")).toEqual(["a", "b|c", ""]);
	});
});

describe("renderRow", () => {
	it("spells an empty cell the way the corpus already does", () => {
		expect(renderRow(["pano", "The board product.", ""])).toBe("| pano | The board product. | |");
	});
});

describe("normalizeCell", () => {
	it("flattens newlines to spaces and escapes a literal pipe", () => {
		expect(normalizeCell("one\ntwo | three\n")).toBe("one two \\| three");
	});
});

describe("parseRegister", () => {
	const parsed = parseRegister(fixture);
	const value = parsed._tag === "Parsed" ? parsed.value : null;

	it("reads only `^## ` headings, so a prose line beginning `#3227).` is not a phantom section", () => {
		expect(value?.sections.map((section) => section.name)).toEqual(["Core / shape", "Indexing"]);
	});

	it("counts a section's data rows, excluding the header and separator rows", () => {
		expect(value?.sections.map((section) => section.rows.length)).toEqual([2, 1]);
	});

	it("records each row's 1-based line and its normalized key", () => {
		const first = value?.sections[0]?.rows[0];
		expect(first?.line).toBe(9);
		expect(first?.key).toBe("pano");
	});

	it("records the separator line, which is the insertion point for an empty table", () => {
		expect(value?.sections[0]?.separatorLine).toBe(8);
	});

	it("parses a register with prose and no table to zero rows — a fact, never malformed", () => {
		const empty = parseRegister("# fixture register with no rows\n\nNo table here.\n");
		expect(empty._tag).toBe("Parsed");
		expect(empty._tag === "Parsed" ? empty.value.rows.length : -1).toBe(0);
	});

	it("refuses a header row with no separator under it — the one malformed shape", () => {
		const broken = parseRegister("## S\n\n| Term | Definition | Not |\n| pano | x | |\n");
		expect(broken._tag).toBe("Malformed");
	});

	/**
	 * The contract names a second `4` trigger — "rows whose cell count the parser cannot resolve" —
	 * that this parser cannot reach: splitting on unescaped pipes resolves a count for every line,
	 * so a short row is a `row-shape` FINDING at exit 0, never a refusal. Pinned so the divergence
	 * is visible rather than inferred.
	 */
	it("resolves a cell count for a short row instead of refusing", () => {
		const short = parseRegister(
			"## S\n\n| Term | Definition | Not |\n|---|---|---|\n| pano | x |\n",
		);
		expect(short._tag).toBe("Parsed");
		expect(short._tag === "Parsed" ? short.value.rows[0]?.cells.length : -1).toBe(2);
	});

	it("counts rows that sit under no heading, which is what `sections` cannot place", () => {
		const orphan = parseRegister("| Term | Definition | Not |\n|---|---|---|\n| pano | x | |\n");
		expect(orphan._tag === "Parsed" ? orphan.value.orphanRows : -1).toBe(1);
	});
});
