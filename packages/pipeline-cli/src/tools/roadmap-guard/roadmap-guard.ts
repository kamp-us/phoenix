/**
 * `roadmap-guard` pure core — decide whether `ROADMAP.md`'s founder-voice tables
 * (`## Arcs`, `## Campaigns`) stay in sync with GitHub milestones, their operational
 * REST projection (roadmap map #2620, guard ruling #2628). IO-free and total: parsing
 * is a transform over the file text, `judge` a transform over the already-gathered
 * rows + milestones. The filesystem read of `ROADMAP.md` and the `gh api` milestone
 * fetch live in `gate.ts`/`github.ts`; this module never touches disk or the network.
 *
 * ROADMAP.md is the SOLE parsed surface; milestones are the projection validated
 * against it (#2630/#2632). The invariants (I1–I4, extended to campaign rows):
 *   I1 — every row is pinned to its milestone BY NUMBER and that milestone exists.
 *        A QUEUED arc gets its milestone lazily on activation, so a queued arc with
 *        no pin is legal; every other row (active/done arc, any campaign) must pin.
 *   I2 — EXACTLY ONE arc row is `active` (the roadmap's "one active arc" law). This
 *        is arcs-only: campaigns run concurrently and may each be active.
 *   I3 — NO UNCLAIMED OPEN MILESTONE: every open milestone is claimed by some row.
 *   I4 — FAIL-CLOSED ON ZERO SCOPE (ADR 0092): zero arc rows or zero milestones ⇒
 *        a non-passing verdict, never a vacuous green (the readme-guard precedent).
 */

/** An arc is sequenced ahead (`queued`) then made current (`active`) and retired (`done`). */
export type ArcState = "active" | "queued" | "done";
/** A campaign has no queued state — it opens `active` and ends `done` (ROADMAP.md § Campaigns). */
export type CampaignState = "active" | "done";

export type RowKind = "arc" | "campaign";

/**
 * One parsed roadmap table row reduced to the facts the invariants need. `milestone`
 * is the `#N` pin resolved to its number, or `null` when the cell is blank/absent
 * (only legal for a queued arc — I1). `state` is the raw, lowercased state cell; row
 * well-formedness (is this state legal for this kind?) is decided in `judge`, not here.
 */
export interface RoadmapRow {
	readonly kind: RowKind;
	/** The founder-voice name in the first column, e.g. `Four Pillars`. */
	readonly name: string;
	readonly milestone: number | null;
	readonly state: string;
}

/** A GitHub milestone reduced to the REST-projection facts the guard validates against. */
export interface Milestone {
	readonly number: number;
	readonly state: "open" | "closed";
	readonly title: string;
}

/** The legal states per row kind — an out-of-set state is drift (a `row-state` violation). */
const ARC_STATES: ReadonlyArray<string> = ["active", "queued", "done"];
const CAMPAIGN_STATES: ReadonlyArray<string> = ["active", "done"];

/**
 * One drift finding. `code` names which invariant fired (`row-state` is the row
 * well-formedness check that backstops I1/I2 — an unrecognized state cell). `message`
 * names the offending row/milestone so the report can print it on stderr (ADR 0092 §1).
 */
export interface Violation {
	readonly code: "I1" | "I2" | "I3" | "row-state";
	readonly message: string;
}

/**
 * The guard verdict. A discriminated union so an invalid state is unrepresentable: a
 * pass carries only counts, the zero-scope fail (I4) carries the two scope counts that
 * tripped it, and the drift fail carries its non-empty violation list.
 */
export type RoadmapGuardVerdict =
	| {
			readonly pass: true;
			readonly arcCount: number;
			readonly campaignCount: number;
			readonly milestoneCount: number;
	  }
	/** Zero arc rows or zero milestones in scope — fail closed, never a vacuous pass (ADR 0092, I4). */
	| {
			readonly pass: false;
			readonly reason: "zero-scope";
			readonly arcCount: number;
			readonly milestoneCount: number;
	  }
	/** Rows/milestones were in scope but at least one of I1–I3 (or row well-formedness) failed. */
	| {
			readonly pass: false;
			readonly reason: "violations";
			readonly violations: ReadonlyArray<Violation>;
	  };

/** Legal states for a row's kind — the backstop set behind I1/I2. */
const legalStates = (kind: RowKind): ReadonlyArray<string> =>
	kind === "arc" ? ARC_STATES : CAMPAIGN_STATES;

/** A row's milestone pin may be legally absent ONLY for a queued arc (lazy-on-activation, I1). */
const pinMayBeAbsent = (row: RoadmapRow): boolean => row.kind === "arc" && row.state === "queued";

/**
 * Decide the verdict over the parsed rows and the live milestone projection.
 *
 * Order: I4 (zero-scope) fails closed first — with no arcs or no milestones there is
 * nothing to meaningfully check, so refuse rather than pass vacuously. Otherwise every
 * violation is collected (row well-formedness, then I1, I2, I3) so one run names all
 * drift, not just the first.
 */
export const judge = (
	arcs: ReadonlyArray<RoadmapRow>,
	campaigns: ReadonlyArray<RoadmapRow>,
	milestones: ReadonlyArray<Milestone>,
): RoadmapGuardVerdict => {
	if (arcs.length === 0 || milestones.length === 0) {
		return {
			pass: false,
			reason: "zero-scope",
			arcCount: arcs.length,
			milestoneCount: milestones.length,
		};
	}

	const rows = [...arcs, ...campaigns];
	const byNumber = new Map(milestones.map((m) => [m.number, m]));
	const violations: Array<Violation> = [];

	// Row well-formedness — an unrecognized state cell is drift the invariants below
	// would otherwise mis-read (a typo'd `activ` would silently drop out of the I2 count).
	for (const row of rows) {
		if (!legalStates(row.kind).includes(row.state)) {
			violations.push({
				code: "row-state",
				message: `${row.kind} row "${row.name}" has an unrecognized state "${row.state}" (allowed: ${legalStates(row.kind).join(", ")})`,
			});
		}
	}

	// I1 — arc→/campaign→milestone pinned by number, and that milestone exists. A queued
	// arc with no pin is tolerated (lazy on activation); any other absent pin is a fail.
	for (const row of rows) {
		if (row.milestone === null) {
			if (!pinMayBeAbsent(row)) {
				violations.push({
					code: "I1",
					message: `${row.kind} row "${row.name}" (state "${row.state}") has no milestone pin — only a queued arc may defer its milestone`,
				});
			}
			continue;
		}
		if (!byNumber.has(row.milestone)) {
			violations.push({
				code: "I1",
				message: `${row.kind} row "${row.name}" is pinned to milestone #${row.milestone}, which does not exist`,
			});
		}
	}

	// I2 — exactly one arc is active (arcs only; campaigns run concurrently).
	const activeArcs = arcs.filter((a) => a.state === "active");
	if (activeArcs.length !== 1) {
		const which =
			activeArcs.length === 0 ? "none" : activeArcs.map((a) => `"${a.name}"`).join(", ");
		violations.push({
			code: "I2",
			message: `expected exactly ONE active arc, found ${activeArcs.length} (${which})`,
		});
	}

	// I3 — no unclaimed open milestone: every open milestone is claimed by some row's pin.
	const claimed = new Set(
		rows.filter((r) => r.milestone !== null).map((r) => r.milestone as number),
	);
	for (const m of milestones) {
		if (m.state === "open" && !claimed.has(m.number)) {
			violations.push({
				code: "I3",
				message: `open milestone #${m.number} ("${m.title}") is not claimed by any arc or campaign row`,
			});
		}
	}

	if (violations.length > 0) {
		return {pass: false, reason: "violations", violations};
	}
	return {
		pass: true,
		arcCount: arcs.length,
		campaignCount: campaigns.length,
		milestoneCount: milestones.length,
	};
};

/** Render the human-readable report for a verdict (ADR 0092 §1 — "emit what you scanned"). */
export const renderReport = (verdict: RoadmapGuardVerdict): string => {
	if (verdict.pass) {
		return (
			`roadmap-guard: in sync — ${verdict.arcCount} arc row(s) + ${verdict.campaignCount} campaign row(s) ` +
			`validated against ${verdict.milestoneCount} milestone(s) (I1–I4 all green).`
		);
	}
	if (verdict.reason === "zero-scope") {
		return (
			`roadmap-guard: scanned ${verdict.arcCount} arc row(s) and ${verdict.milestoneCount} milestone(s) — ` +
			"zero scope on one side, fail-closed (ADR 0092, I4). Is ROADMAP.md's `## Arcs` table present and " +
			"are there milestones to project onto? A vacuous pass would hide real drift."
		);
	}
	const lines = verdict.violations.map((v) => `  [${v.code}] ${v.message}`);
	return (
		`roadmap-guard: ${verdict.violations.length} ROADMAP.md ↔ milestone drift violation(s):\n` +
		`${lines.join("\n")}\n\n` +
		"ROADMAP.md's `## Arcs`/`## Campaigns` tables and the GitHub milestone projection have drifted.\n" +
		"Reconcile the offending row(s)/milestone(s) above (roadmap map #2620; invariants I1–I4, #2632)."
	);
};

// --- ROADMAP.md parsing (pure over the file text) --------------------------------

/** Resolve a `## <heading>` markdown table's milestone cell (`#17`) to its number, else null. */
export const parseMilestoneCell = (cell: string): number | null => {
	const m = cell.match(/#(\d+)/);
	return m?.[1] !== undefined ? Number(m[1]) : null;
};

/**
 * Split one markdown table line (`| a | b | c |`) into its trimmed cells. The leading
 * and trailing pipes yield empty edge fields, which are dropped. A separator row
 * (`|---|---|`) has every cell made only of dashes/colons/spaces — the caller filters
 * those; this just tokenizes.
 */
const splitRow = (line: string): ReadonlyArray<string> => {
	const cells = line.split("|").map((c) => c.trim());
	// Drop the empty fields the leading/trailing `|` produce.
	if (cells.length > 0 && cells[0] === "") cells.shift();
	if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
	return cells;
};

const isSeparatorRow = (cells: ReadonlyArray<string>): boolean =>
	cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));

/**
 * Extract the data rows (header + separator dropped) of the first markdown table under
 * `## <heading>`. Returns `[]` when the heading is absent or has no table — the caller
 * turns an empty `## Arcs` into the I4 zero-scope fail, and an empty `## Campaigns` into
 * a legal no-campaigns roadmap.
 */
export const parseSectionRows = (
	md: string,
	heading: string,
): ReadonlyArray<ReadonlyArray<string>> => {
	const lines = md.split("\n");
	const headingRe = new RegExp(`^##\\s+${heading}\\s*$`, "i");
	let i = 0;
	while (i < lines.length && !headingRe.test(lines[i] ?? "")) i++;
	if (i >= lines.length) return [];
	i++; // past the heading

	const rows: Array<ReadonlyArray<string>> = [];
	let seenTable = false;
	for (; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim();
		if (/^##\s+/.test(line)) break; // next section ends this one
		const isTableLine = line.startsWith("|");
		if (!isTableLine) {
			// A blank/prose line after the table has started terminates it; before it, skip.
			if (seenTable) break;
			continue;
		}
		seenTable = true;
		const cells = splitRow(line);
		if (isSeparatorRow(cells)) continue; // the |---|---| divider
		rows.push(cells);
	}
	// The first surviving row is the header (`Arc | Milestone | State`) — drop it.
	return rows.slice(1);
};

/** Map a `## Arcs`/`## Campaigns` data row's cells (`name | #N | state`) to a `RoadmapRow`. */
const toRow = (kind: RowKind, cells: ReadonlyArray<string>): RoadmapRow => ({
	kind,
	name: (cells[0] ?? "").trim(),
	milestone: parseMilestoneCell(cells[1] ?? ""),
	state: (cells[2] ?? "").trim().toLowerCase(),
});

/**
 * Parse `ROADMAP.md`'s `## Arcs` and `## Campaigns` tables into rows. Rows with an
 * empty name are dropped (a stray table artifact), never turned into a phantom row.
 */
export const parseRoadmap = (
	md: string,
): {readonly arcs: ReadonlyArray<RoadmapRow>; readonly campaigns: ReadonlyArray<RoadmapRow>} => {
	const arcs = parseSectionRows(md, "Arcs")
		.map((cells) => toRow("arc", cells))
		.filter((r) => r.name !== "");
	const campaigns = parseSectionRows(md, "Campaigns")
		.map((cells) => toRow("campaign", cells))
		.filter((r) => r.name !== "");
	return {arcs, campaigns};
};
