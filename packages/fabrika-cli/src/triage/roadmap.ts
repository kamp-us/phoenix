/**
 * The `ROADMAP.md` half of `triage homes`: the `## Arcs` and `## Campaigns` tables, parsed to
 * `<name> → <milestone number>` rows.
 *
 * **The join key is the `#<number>` cell, never the title** — the same row-to-milestone binding
 * `roadmap-guard` enforces. Matching on the title is the obvious shortcut and it is wrong: an arc
 * named `Geçit` pins a milestone titled `Sözlük — search and discovery`, and the two share no
 * substring.
 *
 * The `State` column is deliberately not read. This reports what exists; whether an arc is active is
 * a question for the caller, not a filter here.
 */

/**
 * The declaration file's **shipped default**, relative to the repository root.
 *
 * #6291 put one home under the name and said a key would follow; #6296 is that key —
 * `roadmapFile` in `.fabrika.jsonc` (`../config/keys/paths.ts`), which `build pick`, `build claim`
 * and `triage homes` resolve before they read. This re-export keeps the string written once, for
 * the callers that scaffold the file rather than read a repo's declared one.
 */
export {SHIPPED_ROADMAP_FILE as ROADMAP_FILE} from "../config/keys/paths.ts";

/** One roadmap row: the first column, and the milestone its second column pins. */
export interface RoadmapRow {
	readonly name: string;
	readonly milestone: number;
}

export interface RoadmapRows {
	readonly arcs: ReadonlyArray<RoadmapRow>;
	readonly campaigns: ReadonlyArray<RoadmapRow>;
}

/** The cells of a markdown table row, or `null` for a line that is not one. */
const cells = (line: string): ReadonlyArray<string> | null => {
	const trimmed = line.trim();
	if (!trimmed.startsWith("|")) return null;
	return trimmed
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
};

/**
 * The rows of the table under `## <heading>`, up to the next `## ` heading.
 *
 * A row counts only when its second cell is `#<number>`, which drops the header and the `|---|`
 * separator without matching on their text — so a header rename cannot silently admit a row.
 */
const sectionRows = (text: string, heading: string): ReadonlyArray<RoadmapRow> => {
	const rows: RoadmapRow[] = [];
	let inSection = false;
	for (const line of text.split("\n")) {
		if (line.startsWith("## ")) {
			if (inSection) break;
			inSection = line.trim() === `## ${heading}`;
			continue;
		}
		if (!inSection) continue;
		const fields = cells(line);
		const pinned = fields?.[1] === undefined ? null : /^#(\d+)$/.exec(fields[1]);
		const name = fields?.[0];
		if (pinned?.[1] === undefined || name === undefined || name === "") continue;
		rows.push({name, milestone: Number.parseInt(pinned[1], 10)});
	}
	return rows;
};

export const parseRoadmap = (text: string): RoadmapRows => ({
	arcs: sectionRows(text, "Arcs"),
	campaigns: sectionRows(text, "Campaigns"),
});

/**
 * The name of the first row pinning `milestone`, arcs before campaigns, or `null` when no row does.
 *
 * `null` is a signal worth seeing rather than a row to hide: an open milestone no roadmap row pins
 * is a home that exists off the roadmap.
 */
export const roadmapRowFor = (rows: RoadmapRows, milestone: number): string | null =>
	[...rows.arcs, ...rows.campaigns].find((row) => row.milestone === milestone)?.name ?? null;
