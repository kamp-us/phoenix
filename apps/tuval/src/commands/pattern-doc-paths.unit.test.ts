/**
 * The drift guard on `.patterns/tuval-spells.md`: every repo path that page links to has to exist,
 * and every row of its file table has to still describe the module it points at.
 *
 * A reference page whose file table names a module that moved sends its reader nowhere, and nothing
 * else in CI reads it. So this resolves each markdown link target the doc carries and stats it, then
 * walks the table row by row — a row's own link is its citation, and the identifiers the row lists
 * have to be findable in the file it cites.
 */

import {existsSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {join, normalize, resolve} from "node:path";
import {describe, expect, it} from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const docPath = join(repoRoot, ".patterns/tuval-spells.md");

/** Every `[text](target)` whose target is a relative path, deduped, in document order. */
const linkedPaths = (markdown: string): ReadonlyArray<string> => {
	const targets = new Set<string>();
	for (const match of markdown.matchAll(/\]\((\.[^)\s]+)\)/g)) {
		const target = match[1];
		if (target !== undefined) targets.add(target.split("#")[0] ?? target);
	}
	return [...targets];
};

/** One row of the `## The pieces, by file` table: the module it names, and what it claims is in it. */
interface Row {
	readonly module: string;
	readonly target: string;
	readonly claims: ReadonlyArray<string>;
}

/**
 * The table rows, read as rows rather than as loose links. A count over the page's links cannot
 * tell a table that lost half its rows from one that never had them; a row can.
 */
const fileTable = (markdown: string): ReadonlyArray<Row> => {
	const section = markdown.split("## The pieces, by file")[1]?.split("\n## ")[0] ?? "";
	const rows: Array<Row> = [];
	for (const line of section.split("\n")) {
		// Every row of the table, not only the ones that still carry a link: a row filter keyed on
		// `| [` drops the row that lost its link, which is the drift this whole read is for.
		if (!line.startsWith("|") || /^\|[\s|:-]*$/.test(line)) continue;
		const [, first = "", second = ""] = line.split("|");
		if (first.trim() === "File") continue;
		const link = /^\s*\[`([^`]+)`\]\(([^)]+)\)\s*$/.exec(first);
		if (link === null) {
			rows.push({module: first.trim(), target: "", claims: []});
			continue;
		}
		rows.push({
			module: link[1] ?? "",
			target: link[2] ?? "",
			// Only identifier-shaped backticks: a row also backticks directory names (`core/`) and
			// prose, and neither is a name to look for in a file.
			claims: [...second.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((match) => match[1] ?? ""),
		});
	}
	return rows;
};

const pathOf = (target: string): string => normalize(join(repoRoot, ".patterns", target));

describe(".patterns/tuval-spells.md", () => {
	it("links only to paths that exist", async () => {
		const markdown = await readFile(docPath, "utf8");
		const targets = linkedPaths(markdown);

		expect(targets.length).toBeGreaterThan(0);

		const missing = targets.filter((target) => !existsSync(pathOf(target)));
		expect(missing).toEqual([]);
	});

	it("cites the code each of its file-table rows describes", async () => {
		const markdown = await readFile(docPath, "utf8");
		const rows = fileTable(markdown);

		expect(rows.length, "the file table has no rows").toBeGreaterThan(0);

		const uncited = rows.filter((row) => row.target === "");
		expect(
			uncited.map((row) => row.module),
			"a table row names a module it does not link",
		).toEqual([]);

		const mispointed = rows.filter(
			(row) => !row.target.endsWith(`/${row.module}`) || !row.target.includes("apps/tuval/src/"),
		);
		expect(
			mispointed.map((row) => `${row.module} -> ${row.target}`),
			"a table row links somewhere other than the module it names",
		).toEqual([]);
	});

	it("names, in each row, identifiers that are still in that row's module", async () => {
		const markdown = await readFile(docPath, "utf8");
		const rows = fileTable(markdown);
		const claimed = rows.reduce((total, row) => total + row.claims.length, 0);
		expect(claimed, "no row names anything the module has to hold").toBeGreaterThan(0);

		const gone: Array<string> = [];
		for (const row of rows) {
			if (row.claims.length === 0) continue;
			const source = await readFile(pathOf(row.target), "utf8");
			for (const claim of row.claims) {
				if (!source.includes(claim)) gone.push(`${row.module}: ${claim}`);
			}
		}
		expect(gone, "a table row names something its module no longer holds").toEqual([]);
	});
});
