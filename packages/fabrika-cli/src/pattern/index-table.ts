/**
 * The index `pattern corpus` reads and `pattern register` edits, parsed once.
 *
 * **Row parsing is positional, never a region scan.** A doc counts as registered only when a
 * markdown table row's FIRST cell links its filename; a mention anywhere else — a sentence of
 * prose, a reading-order note, a second cell — is not a registration. v1's check was
 * `grep -n "$NAME.md" index.md`: unanchored, whole-file, and with `.` as a regex any-char, so prose
 * passed as a row.
 */

/** A cell's escapes undone, so a row's text round-trips through {@link composeRow}. */
const unescapeCell = (cell: string): string => cell.replace(/\\\|/g, "|").trim();

/** The cells of a table row, or `null` when the line is not one. */
export const rowCells = (line: string): ReadonlyArray<string> | null => {
	const trimmed = line.trim();
	if (!trimmed.startsWith("|")) return null;
	const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
	return inner.split(/(?<!\\)\|/).map(unescapeCell);
};

/** A table's `|---|---|` delimiter — what makes the lines around it a table rather than prose. */
export const isDelimiterRow = (line: string): boolean => {
	const cells = rowCells(line);
	return cells !== null && cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
};

/** The first markdown link target in a cell, verbatim, or `null`. */
export const linkTarget = (cell: string): string | null =>
	/\[[^\]]*\]\(([^)]+)\)/.exec(cell)?.[1]?.trim() ?? null;

/**
 * A link target read as a **member name of the doc directory**, or `null` when it names something
 * else.
 *
 * A target carrying a directory component, a scheme, or an anchor onto another file is not a member
 * — which is the whole point of the `dangling` line: an ADR, a doc in a subdirectory or a file
 * outside `--dir` resolves perfectly well and is still not a member of this corpus.
 */
export const memberName = (target: string): string | null => {
	const path = target.split("#")[0]?.split("?")[0] ?? "";
	const bare = path.startsWith("./") ? path.slice(2) : path;
	return bare === "" || bare.includes("/") || bare.includes(":") ? null : bare;
};

export interface IndexRow {
	/** 0-based line index, so an insertion can be placed without re-finding the row. */
	readonly line: number;
	/** The first cell's link target, verbatim, or `null` when the cell links nothing. */
	readonly target: string | null;
	/** The target read as a member of the doc directory, or `null`. */
	readonly member: string | null;
	/** The enclosing heading's text, or `-` when the row sits above the first heading. */
	readonly section: string;
}

export interface IndexSection {
	/** The heading text, leading `#` characters and surrounding whitespace stripped. */
	readonly heading: string;
	readonly headingLine: number;
	/** Every table row under it, in document order. */
	readonly rows: ReadonlyArray<IndexRow>;
	/** Where an insertion goes: the last table row's line, or `null` when the section has no table. */
	readonly lastRowLine: number | null;
	readonly hasTable: boolean;
}

export interface ParsedIndex {
	readonly sections: ReadonlyArray<IndexSection>;
	/** Every table row anywhere in the document, in document order. */
	readonly rows: ReadonlyArray<IndexRow>;
	/** Whether any table was found at all — the `15` question. */
	readonly hasTable: boolean;
}

/** The section heading text of a `#`-prefixed line, or `null`. */
const headingTextOf = (line: string): string | null => {
	const m = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
	return m?.[2] === undefined ? null : m[2].replace(/\s+#*\s*$/, "").trim();
};

export const parseIndex = (text: string): ParsedIndex => {
	const lines = text.split("\n");
	const sections: IndexSection[] = [];
	const rows: IndexRow[] = [];

	let heading = "-";
	let headingLine = -1;
	let current: IndexRow[] = [];
	let currentHasTable = false;

	const close = () => {
		if (headingLine === -1 && current.length === 0 && !currentHasTable) return;
		sections.push({
			heading,
			headingLine,
			rows: current,
			lastRowLine: current.at(-1)?.line ?? null,
			hasTable: currentHasTable,
		});
	};

	for (const [at, line] of lines.entries()) {
		const head = headingTextOf(line);
		if (head !== null) {
			close();
			heading = head;
			headingLine = at;
			current = [];
			currentHasTable = false;
			continue;
		}
		if (isDelimiterRow(line)) {
			currentHasTable = true;
			continue;
		}
		const cells = rowCells(line);
		if (cells === null) continue;
		const target = linkTarget(cells[0] ?? "");
		const row: IndexRow = {
			line: at,
			target,
			member: target === null ? null : memberName(target),
			section: heading,
		};
		current.push(row);
		rows.push(row);
	}
	close();

	return {sections, rows, hasTable: sections.some((s) => s.hasTable)};
};

/** Every section that carries a table, in document order — the set `--section` may name. */
export const tableSections = (index: ParsedIndex): ReadonlyArray<string> =>
	index.sections.filter((s) => s.hasTable && s.headingLine !== -1).map((s) => s.heading);

/** A cell's tabs and newlines stripped and its pipes escaped, so one row stays one line. */
export const cellText = (value: string): string =>
	value
		.replace(/[\t\n\r]+/g, " ")
		.replace(/\|/g, "\\|")
		.trim();

/** The row's bytes: a link to the doc, then the two authored cells. */
export const composeRow = (slug: string, topic: string, readWhen: string): string =>
	`| [${slug}.md](./${slug}.md) | ${cellText(topic)} | ${cellText(readWhen)} |`;
