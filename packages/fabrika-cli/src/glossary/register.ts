/**
 * What a register file *is*, as data: its sections, its rows, and the one comparison key every verb
 * in the group compares by.
 *
 * The whole first cell is one key. Splitting a parenthetical into an alias is the defect that
 * produced three false duplicates the last time it was attempted (#4206) — a parenthetical in this
 * corpus is a disambiguating qualifier, not a synonym — so `tag` and `Database (tag)` are different
 * terms that *overlap*, and resolving that overlap is the skill's judgement, not this module's.
 */

/** The two registers, and the file each is stored in under `--dir`. */
export type RegisterName = "terms" | "language";

export const REGISTER_FILE: Readonly<Record<RegisterName, string>> = {
	terms: "TERMS.md",
	language: "LANGUAGE.md",
};

/** `both` means TERMS first, then LANGUAGE, in that order everywhere. */
export const BOTH: ReadonlyArray<RegisterName> = ["terms", "language"];

/**
 * The comparison key for a first cell.
 *
 * Lowercasing is `toLocaleLowerCase`, which is Unicode-aware rather than `[a-z]`-restricted: `Sözlük`
 * and `sözlük` are one key, and `Geçit` is not silently dropped the way v1's ASCII tokenizer dropped
 * every Turkish product noun (#4481).
 */
export const normalizeKey = (cell: string): string =>
	cell
		.replace(/^[`*_]+/, "")
		.replace(/[`*_]+$/, "")
		.toLocaleLowerCase()
		.replace(/[-_\s]+/g, " ")
		.trim();

const WORD = /[\p{L}\p{N}_]/u;

const isWord = (ch: string | undefined): boolean => ch !== undefined && WORD.test(ch);

/** A `\b`-style boundary at `at`: the characters either side differ in word-ness. */
const isBoundary = (text: string, at: number): boolean => isWord(text[at - 1]) !== isWord(text[at]);

const containsWholeWord = (haystack: string, needle: string): boolean => {
	if (needle === "") return false;
	for (let from = 0; ; ) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) return false;
		if (isBoundary(haystack, at) && isBoundary(haystack, at + needle.length)) return true;
		from = at + 1;
	}
};

/**
 * Whether two normalized keys overlap: they differ, and one contains the other as a whole-word span.
 *
 * `front door` overlaps `front door detection`; it does not overlap `storefront doorway`.
 */
export const overlaps = (a: string, b: string): boolean =>
	a !== b && (containsWholeWord(a, b) || containsWholeWord(b, a));

export interface Row {
	/** The first cell verbatim, as the file spells it. */
	readonly term: string;
	readonly key: string;
	readonly cells: ReadonlyArray<string>;
	readonly section: string;
	/** 1-based line number in the file. */
	readonly line: number;
}

export interface Section {
	readonly name: string;
	/** 1-based line of the `## ` heading. */
	readonly headingLine: number;
	/**
	 * 1-based line of the first table's separator row, or `null` when the section holds no table.
	 *
	 * It is what makes an insertion point exist for a section whose table has a header and no data
	 * rows yet — a state `rows` alone cannot tell apart from a section with no table at all.
	 */
	readonly separatorLine: number | null;
	readonly rows: ReadonlyArray<Row>;
}

export interface ParsedRegister {
	readonly sections: ReadonlyArray<Section>;
	/** Every row in file order, whichever section holds it. */
	readonly rows: ReadonlyArray<Row>;
	/** Rows that sit under no `## ` heading — what makes `sections` unable to place content. */
	readonly orphanRows: number;
	readonly headings: number;
}

export type ParseResult =
	| {readonly _tag: "Parsed"; readonly value: ParsedRegister}
	| {readonly _tag: "Malformed"; readonly reason: string};

/**
 * A heading the section list is read from. The space after the hashes is required by the markdown
 * spec and is load-bearing: `TERMS.md` carries a prose line beginning `#3227).`, and a scan for `^#`
 * reports it as a phantom section.
 */
const SECTION_HEADING = /^##[ \t]+(\S.*)$/;
/** An H1 or H2 — either closes the current section's table. */
const ANY_HEADING = /^#{1,2}[ \t]+\S/;

const isTableLine = (line: string): boolean => line.trim().startsWith("|");

/**
 * Split a table row into cells, honouring `\|` as a literal pipe and `\\` as a literal backslash.
 *
 * The backslash arm is the half that makes this the exact inverse of {@link escapeCell}. Without it
 * the escape is incomplete in the classic direction: a cell whose own text ends in a backslash would
 * fuse with the delimiter that follows it, so a value could smuggle in a column separator that
 * `escapeCell` believed it had neutralized.
 */
export const splitCells = (line: string): ReadonlyArray<string> => {
	let text = line.trim();
	if (text.startsWith("|")) text = text.slice(1);
	if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
	const cells: string[] = [];
	let cell = "";
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i] as string;
		if (ch === "\\" && (text[i + 1] === "|" || text[i + 1] === "\\")) {
			cell += text[i + 1] as string;
			i += 1;
			continue;
		}
		if (ch === "|") {
			cells.push(cell.trim());
			cell = "";
			continue;
		}
		cell += ch;
	}
	cells.push(cell.trim());
	return cells;
};

/** `|---|---|---|` and its `:---:` variants — the row that makes the line above it a header. */
export const isSeparatorRow = (line: string): boolean => {
	if (!isTableLine(line)) return false;
	const cells = splitCells(line);
	return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
};

/**
 * A register's sections and rows.
 *
 * `Malformed` is reserved for a table that **exists and cannot be resolved** — today that is a header
 * row with no separator under it. A file with no table at all parses to zero rows, which is a fact
 * about an adopting repo rather than a defect.
 */
export const parseRegister = (text: string): ParseResult => {
	const lines = text.split("\n");
	const sections: Section[] = [];
	const rows: Row[] = [];
	let current: {
		name: string;
		headingLine: number;
		separatorLine: number | null;
		rows: Row[];
	} | null = null;
	let orphanRows = 0;
	let headings = 0;
	let inTable = false;

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] as string;
		const heading = SECTION_HEADING.exec(line);
		if (heading !== null) {
			if (current !== null) sections.push({...current, rows: current.rows});
			headings += 1;
			current = {
				name: (heading[1] as string).trim(),
				headingLine: i + 1,
				separatorLine: null,
				rows: [],
			};
			inTable = false;
			continue;
		}
		if (ANY_HEADING.test(line)) {
			if (current !== null) sections.push({...current, rows: current.rows});
			current = null;
			inTable = false;
			continue;
		}
		if (!isTableLine(line)) {
			if (line.trim() === "") inTable = false;
			continue;
		}
		if (!inTable) {
			// The first `|` line of a table is its header row, and a header with no separator under it
			// is a table whose columns cannot be resolved — the one shape this parser calls malformed.
			const next = lines[i + 1];
			if (next === undefined || !isSeparatorRow(next)) {
				return {
					_tag: "Malformed",
					reason: `the table header row at line ${i + 1} is not followed by a separator row`,
				};
			}
			inTable = true;
			if (current !== null && current.separatorLine === null) current.separatorLine = i + 2;
			i += 1;
			continue;
		}
		const cells = splitCells(line);
		const term = cells[0] ?? "";
		const row: Row = {
			term,
			key: normalizeKey(term),
			cells,
			section: current?.name ?? "",
			line: i + 1,
		};
		rows.push(row);
		if (current === null) orphanRows += 1;
		else current.rows.push(row);
	}
	if (current !== null) sections.push({...current, rows: current.rows});

	return {_tag: "Parsed", value: {sections, rows, orphanRows, headings}};
};

/** A cell's text as one line: newlines become single spaces, so a row cannot grow a line. */
export const flattenCell = (text: string): string => text.replace(/\r\n|\r|\n/g, " ").trim();

/**
 * A cell's text written so it stays content: `|` cannot grow a column, and the escape character
 * itself cannot be forged.
 *
 * **The backslash is escaped FIRST, and that order is the whole correctness of the pair.** Escaping
 * only `|` leaves the encoding ambiguous — a cell ending in `\` would render as `…\ |`, and its own
 * trailing backslash would then read as escaping the delimiter that follows. `splitCells` is the
 * exact inverse and unescapes both.
 */
export const escapeCell = (text: string): string =>
	text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

export const normalizeCell = (text: string): string => escapeCell(flattenCell(text));

/** A row's bytes. An empty cell renders as `| |`, which is how the corpus already spells one. */
export const renderRow = (cells: ReadonlyArray<string>): string =>
	`|${cells.map((cell) => (cell === "" ? " " : ` ${cell} `)).join("|")}|`;

/** The distinct normalized keys a row set declares — what a caller counts instead of rows. */
export const declaredKeys = (rows: ReadonlyArray<Row>): ReadonlySet<string> =>
	new Set(rows.map((row) => row.key));
