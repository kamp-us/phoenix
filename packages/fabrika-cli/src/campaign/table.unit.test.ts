import {describe, expect, it} from "vitest";
import {parseCampaigns, readCampaigns, scanCampaigns} from "../build/scope-admission.ts";
import {TWO_ROWS} from "./fixtures.test-support.ts";
import {appendRow, nameFitsCell, placedRows, rewriteState, rowLine, selects} from "./table.ts";

const rowsOf = (text: string) => {
	const parsed = parseCampaigns(text);
	if (parsed._tag === "Malformed") throw new Error(parsed.reason);
	return parsed.rows;
};

describe("parseCampaigns — the extraction the fence narrows", () => {
	it("returns every row whatever its state, where readCampaigns keeps only the active ones", () => {
		expect(rowsOf(TWO_ROWS)).toEqual([
			{milestone: 42, state: "paused", name: "Taste-Skill Library"},
			{milestone: 47, state: "active", name: "fabrika everywhere"},
		]);
		expect(readCampaigns(TWO_ROWS)).toEqual({
			_tag: "Active",
			campaigns: [{milestone: 47, name: "fabrika everywhere"}],
		});
	});

	it("calls an all-paused table rows, where the fence calls the same table None", () => {
		const paused = TWO_ROWS.replace("| active |", "| paused |");
		expect(rowsOf(paused)).toHaveLength(2);
		expect(readCampaigns(paused)).toEqual({_tag: "None"});
	});

	it("reads an absent heading and an empty table as the same well-formed default", () => {
		expect(parseCampaigns("# Roadmap\n")).toEqual({_tag: "Rows", rows: []});
		expect(
			parseCampaigns("## Campaigns\n\n| Campaign | Milestone | State |\n|---|---|---|\n"),
		).toEqual({_tag: "Rows", rows: []});
	});

	it("makes the WHOLE table unreadable on one bad row, never a partial read", () => {
		const broken = TWO_ROWS.replace("| #42 |", "| (was #42) |");
		expect(parseCampaigns(broken)._tag).toBe("Malformed");
		expect(readCampaigns(broken)._tag).toBe("Malformed");
	});

	it("stops at the next ## heading, so a table below it is another section", () => {
		expect(scanCampaigns(TWO_ROWS).rows).toHaveLength(2);
	});
});

describe("appendRow", () => {
	it("appends after the current last row and touches nothing else", () => {
		const next = appendRow(TWO_ROWS, "Mecmua reading layout", 52);
		expect(rowsOf(next).at(-1)).toEqual({
			milestone: 52,
			state: "paused",
			name: "Mecmua reading layout",
		});
		expect(next.split("\n").slice(0, 8)).toEqual(TWO_ROWS.split("\n").slice(0, 8));
	});

	it("writes the row immediately after the separator when the table has no rows", () => {
		const empty = "## Campaigns\n\n| Campaign | Milestone | State |\n|---|---|---|\n\n## Next\n";
		const next = appendRow(empty, "First", 1);
		expect(next.split("\n")[4]).toBe("| First | #1 | paused |");
	});

	it("scaffolds the header under an existing heading that carries no table", () => {
		const next = appendRow("# Roadmap\n\n## Campaigns\n\nprose.\n", "First", 1);
		expect(rowsOf(next)).toEqual([{milestone: 1, state: "paused", name: "First"}]);
		expect(next).toContain("| Campaign | Milestone | State |");
	});

	it("writes the heading as the last section when the file has none", () => {
		const next = appendRow("# Roadmap\n\n## Arcs\n\nprose.\n", "First", 1);
		expect(next.endsWith("| First | #1 | paused |\n")).toBe(true);
		expect(rowsOf(next)).toEqual([{milestone: 1, state: "paused", name: "First"}]);
	});
});

describe("rewriteState", () => {
	const line = scanCampaigns(TWO_ROWS).rows[0]?.index ?? -1;

	it("swaps the token and leaves every other line byte-identical", () => {
		const next = rewriteState(TWO_ROWS, line, "active") ?? "";
		const before = TWO_ROWS.split("\n");
		const after = next.split("\n");
		expect(after.filter((row, at) => row !== before[at])).toEqual([
			"| Taste-Skill Library | #42 | active |",
		]);
	});

	it("preserves the cell's padding exactly rather than re-padding to a column width", () => {
		const padded = TWO_ROWS.replace("| #42 | paused |", "| #42 |  paused  |");
		const at = scanCampaigns(padded).rows[0]?.index ?? -1;
		expect(rewriteState(padded, at, "done") ?? "").toContain("| #42 |  done  |");
	});

	it("flips a row whose trailing pipe is absent, which the parse reads and so must the writer", () => {
		const open = TWO_ROWS.replace("| #42 | paused |", "| #42 | paused");
		const at = scanCampaigns(open).rows[0]?.index ?? -1;
		const next = rewriteState(open, at, "active") ?? "";
		expect(rowsOf(next)[0]).toEqual({milestone: 42, state: "active", name: "Taste-Skill Library"});
		const before = open.split("\n");
		expect(next.split("\n").filter((row, index) => row !== before[index])).toEqual([
			"| Taste-Skill Library | #42 | active",
		]);
	});

	it("keeps the padding of a trailing-pipe-less cell, trailing spaces and all", () => {
		const open = TWO_ROWS.replace("| #42 | paused |", "| #42 |  paused  ");
		const at = scanCampaigns(open).rows[0]?.index ?? -1;
		expect(rewriteState(open, at, "done") ?? "").toContain("| #42 |  done  \n");
	});

	it("returns null on a line carrying more cells than the grammar declares", () => {
		const lines = TWO_ROWS.split("\n");
		const at = scanCampaigns(TWO_ROWS).rows[0]?.index ?? -1;
		lines[at] = "| Taste-Skill Library | #42 | paused | extra |";
		expect(rewriteState(lines.join("\n"), at, "active")).toBeNull();
	});
});

describe("selects", () => {
	const placed = placedRows(TWO_ROWS);
	const rows = placed._tag === "Rows" ? placed.rows : [];

	it("matches a #<n> selector against the pin", () => {
		expect(rows.filter((row) => selects(row, "#42")).map((row) => row.row.name)).toEqual([
			"Taste-Skill Library",
		]);
	});

	it("matches anything else against the first cell character for character", () => {
		expect(rows.filter((row) => selects(row, "fabrika everywhere"))).toHaveLength(1);
		expect(rows.filter((row) => selects(row, "fabrika"))).toHaveLength(0);
	});

	it("carries each row's line index, so a writer edits the row it selected", () => {
		expect(rows.map((row) => row.line)).toEqual(
			scanCampaigns(TWO_ROWS).rows.map((row) => row.index),
		);
	});
});

describe("rowLine and nameFitsCell", () => {
	it("prints a row as #<milestone>\\t<state>\\t<name>", () => {
		expect(rowLine({milestone: 47, state: "active", name: "fabrika everywhere"})).toBe(
			"#47\tactive\tfabrika everywhere",
		);
	});

	it("refuses a name carrying a pipe or a newline", () => {
		expect(nameFitsCell("fine")).toBe(true);
		expect(nameFitsCell("a | b")).toBe(false);
		expect(nameFitsCell("a\nb")).toBe(false);
	});
});
