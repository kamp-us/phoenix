/**
 * The `## Campaigns` writers, added **beside** the fence's parse rather than as a fourth parser.
 *
 * Every cell this module reads comes from `../build/scope-admission.ts` — `scanCampaigns` for where
 * a row sits, `parseCampaigns` for what it says — so a row a verb here writes and the dispatch fence
 * calls `Malformed` is unconstructible. Binding to `../guard/roadmap.ts` instead would buy exactly
 * that divergence: its pin regex is unanchored and its milestone cell is resolved away, so it admits
 * rows the fence refuses.
 */

import {
	type CampaignRow,
	type CampaignState,
	parseCampaigns,
	scanCampaigns,
} from "../build/scope-admission.ts";

/** The one shape every verb prints a row in. */
export const rowLine = (row: CampaignRow): string => `#${row.milestone}\t${row.state}\t${row.name}`;

/** The bytes a fresh table is scaffolded with — nothing else, because the prose is founder-voice. */
const HEADER_LINES = ["| Campaign | Milestone | State |", "|----------|-----------|-------|"];

const dataLine = (name: string, milestone: number, state: CampaignState): string =>
	`| ${name} | #${milestone} | ${state} |`;

/** A `<name>` that cannot be written into a table cell at all. */
export const nameFitsCell = (name: string): boolean => !name.includes("|") && !/[\r\n]/.test(name);

/**
 * Append a `paused` row for `name` at `milestone`, returning the whole file's new text.
 *
 * Three insertion points, one per state the file can be in, because leaving them to the implementer
 * is how one implementation scaffolds the heading and another refuses.
 */
export const appendRow = (text: string, name: string, milestone: number): string => {
	const lines = text.split("\n");
	const scan = scanCampaigns(text);
	const row = dataLine(name, milestone, "paused");

	const last = scan.rows.at(-1);
	if (last !== undefined) {
		lines.splice(last.index + 1, 0, row);
		return lines.join("\n");
	}
	if (scan.separator !== null) {
		lines.splice(scan.separator + 1, 0, row);
		return lines.join("\n");
	}
	if (scan.heading !== null) {
		lines.splice(scan.heading + 1, 0, "", ...HEADER_LINES, row);
		return lines.join("\n");
	}
	// A file with no heading grows one as its last `## ` section, which is where a reader of a
	// roadmap looks for a table nobody has written yet.
	const trailing = text.endsWith("\n") ? "" : "\n";
	return `${text}${trailing}\n## Campaigns\n\n${[...HEADER_LINES, row].join("\n")}\n`;
};

/**
 * Swap one row's state token in place, returning the whole file's new text.
 *
 * Only the token moves: the cell's leading and trailing whitespace is preserved exactly as found and
 * the cell is **never re-padded to a column width**, so `paused` → `done` shortens the line and every
 * other line of the file is byte-identical afterwards. Re-padding would be a second, silent edit the
 * caller did not ask for.
 *
 * The trailing pipe is optional, exactly as it is for `cellsOf` in the fence's parse: `| a | #1 |
 * paused` is a readable row there, so it is a writable one here. A writer stricter than the parse
 * would refuse to flip a row `campaign list` prints, which is the disagreement this module exists to
 * make unconstructible.
 *
 * `null` is the residual: the located line does not carry the three cells the parse read off it.
 * Nothing is written on that arm, so a caller must seat it where *nothing was attempted* is true.
 */
export const rewriteState = (text: string, line: number, to: CampaignState): string | null => {
	const lines = text.split("\n");
	const raw = lines[line];
	if (raw === undefined) return null;
	const pipes = [...raw].flatMap((char, index) => (char === "|" ? [index] : []));
	const open = pipes[2];
	if (open === undefined || pipes.length > 4) return null;
	const close = pipes[3] ?? raw.length;
	const cell = raw.slice(open + 1, close);
	const spans = /^(\s*)(\S+)(\s*)$/.exec(cell);
	if (spans === null) return null;
	lines[line] = `${raw.slice(0, open + 1)}${spans[1]}${to}${spans[3]}${raw.slice(close)}`;
	return lines.join("\n");
};

/** A row, and the line it sits on — what a writer needs and `parseCampaigns` alone cannot give. */
export interface PlacedRow {
	readonly row: CampaignRow;
	readonly line: number;
}

export type PlacedTable =
	| {readonly _tag: "Rows"; readonly rows: ReadonlyArray<PlacedRow>}
	| {readonly _tag: "Malformed"; readonly reason: string};

/**
 * Every readable row with its line index, by zipping the scan against the parse.
 *
 * Positional alignment is safe because `parseCampaigns` refuses the **whole** table on the first
 * unreadable row rather than returning a short list, so a `Rows` answer holds one entry per scanned
 * line, in order.
 */
export const placedRows = (text: string): PlacedTable => {
	const parsed = parseCampaigns(text);
	if (parsed._tag === "Malformed") return parsed;
	const scanned = scanCampaigns(text).rows;
	return {
		_tag: "Rows",
		rows: parsed.rows.map((row, index) => ({row, line: scanned[index]?.index ?? -1})),
	};
};

/** How `campaign state`'s positional argument names a row: by pin, or by exact name. */
export const selects = (placed: PlacedRow, selector: string): boolean => {
	const pin = /^#(\d+)$/.exec(selector.trim());
	return pin?.[1] === undefined
		? placed.row.name === selector.trim()
		: placed.row.milestone === Number.parseInt(pin[1], 10);
};
