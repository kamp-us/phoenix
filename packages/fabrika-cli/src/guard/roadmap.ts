/**
 * `guard roadmap-guard check`'s pure core — does `ROADMAP.md` still agree with the live milestone
 * projection? Ported from `pipeline-cli roadmap-guard` (#2620/#2628/#2660/#5012).
 *
 * **`ROADMAP.md` is the only surface parsed here.** Milestones are the projection it is checked
 * against, never a second source it is reconciled with — so drift always has one author.
 *
 * The six invariants, because they live nowhere else:
 *   I1 — every row pins its milestone BY NUMBER and that milestone exists. A `queued` arc gets its
 *        milestone on activation, so a queued arc with no pin is legal; nothing else may defer.
 *   I2 — EXACTLY ONE arc is `active`. Arcs only: campaigns run concurrently.
 *   I3 — every OPEN milestone is claimed by some row.
 *   I4 — zero arc rows or zero milestones fails closed, never a vacuous green (ADR 0092).
 *   I5 — an `active` row's milestone is open and a `done` row's is closed. A queued arc is exempt
 *        (I1's lazy pin); a row whose pin dangles is already an I1 and is not re-reported.
 *   I6 — `## Focus` carries at most one row, and it pins an OPEN milestone some `active` row claims.
 *        An absent or empty `## Focus` is the well-formed default, never a violation.
 *
 * Total and IO-free: `./roadmap-verb.ts` reads the file and the projection.
 */

/** An arc is sequenced ahead (`queued`), made current (`active`), then retired (`done`). */
export type ArcState = "active" | "queued" | "done";
/** A campaign has no queued state — it opens `active` and ends `done`. */
export type CampaignState = "active" | "done";

export type RowKind = "arc" | "campaign";

/**
 * One parsed table row, reduced to what the invariants read. `milestone` is the `#N` pin resolved to
 * its number, or `null` for a blank cell. `state` is the raw lowercased cell — whether that state is
 * legal for this kind is {@link judge}'s call, not the parser's.
 */
export interface RoadmapRow {
	readonly kind: RowKind;
	readonly name: string;
	readonly milestone: number | null;
	readonly state: string;
}

/**
 * One `## Focus` row. Unlike a queued arc's deferred pin, a `null` here is always a violation: a
 * declaration that names nothing declares nothing.
 */
export interface FocusRow {
	readonly milestone: number | null;
	/** The raw `Declared` cell. Carried so the violation can say which declaration is wrong. */
	readonly declaredAt: string;
}

/** A milestone reduced to the projection facts the guard validates against. */
export interface Milestone {
	readonly number: number;
	readonly state: "open" | "closed";
	readonly title: string;
}

const ARC_STATES: ReadonlyArray<string> = ["active", "queued", "done"];
const CAMPAIGN_STATES: ReadonlyArray<string> = ["active", "done"];

/** One drift finding. `row-state` backstops I1/I2: a typo'd `activ` would drop out of I2's count. */
export interface Violation {
	readonly code: "I1" | "I2" | "I3" | "I5" | "I6" | "row-state";
	readonly message: string;
}

/**
 * A pass carries only counts, a zero-scope fail the two counts that tripped it, a drift fail its
 * non-empty findings — so a verdict claiming a scope it never had is unrepresentable.
 */
export type RoadmapVerdict =
	| {
			readonly pass: true;
			readonly arcCount: number;
			readonly campaignCount: number;
			readonly milestoneCount: number;
			/** 0 or 1 — I6 admits no more. */
			readonly focusCount: number;
	  }
	| {
			readonly pass: false;
			readonly reason: "zero-scope";
			readonly arcCount: number;
			readonly milestoneCount: number;
	  }
	| {
			readonly pass: false;
			readonly reason: "violations";
			readonly violations: ReadonlyArray<Violation>;
	  };

const legalStates = (kind: RowKind): ReadonlyArray<string> =>
	kind === "arc" ? ARC_STATES : CAMPAIGN_STATES;

const pinMayBeAbsent = (row: RoadmapRow): boolean => row.kind === "arc" && row.state === "queued";

/**
 * The verdict over the parsed rows and the live projection.
 *
 * I4 fails closed first: with no arcs or no milestones there is nothing to check, so a green would
 * be vacuous. Past that every violation is collected, so one run names all the drift.
 *
 * `focus` defaults to empty because that IS the well-formed default (nothing declared), not a
 * convenience for the caller.
 */
export const judge = (
	arcs: ReadonlyArray<RoadmapRow>,
	campaigns: ReadonlyArray<RoadmapRow>,
	milestones: ReadonlyArray<Milestone>,
	focus: ReadonlyArray<FocusRow> = [],
): RoadmapVerdict => {
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

	for (const row of rows) {
		if (!legalStates(row.kind).includes(row.state)) {
			violations.push({
				code: "row-state",
				message: `${row.kind} row "${row.name}" has an unrecognized state "${row.state}" (allowed: ${legalStates(row.kind).join(", ")})`,
			});
		}
	}

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

	const activeArcs = arcs.filter((a) => a.state === "active");
	if (activeArcs.length !== 1) {
		const which =
			activeArcs.length === 0 ? "none" : activeArcs.map((a) => `"${a.name}"`).join(", ");
		violations.push({
			code: "I2",
			message: `expected exactly ONE active arc, found ${activeArcs.length} (${which})`,
		});
	}

	const claimed = new Set(rows.flatMap((r) => (r.milestone === null ? [] : [r.milestone])));
	for (const m of milestones) {
		if (m.state === "open" && !claimed.has(m.number)) {
			violations.push({
				code: "I3",
				message: `open milestone #${m.number} ("${m.title}") is not claimed by any arc or campaign row`,
			});
		}
	}

	for (const row of rows) {
		if (row.milestone === null) continue;
		const m = byNumber.get(row.milestone);
		// A dangling pin is already an I1; reporting it again as an I5 would double-count one fault.
		if (m === undefined) continue;
		const expected = row.state === "active" ? "open" : row.state === "done" ? "closed" : null;
		if (expected !== null && m.state !== expected) {
			violations.push({
				code: "I5",
				message: `${row.kind} row "${row.name}" is "${row.state}" but its milestone #${m.number} ("${m.title}") is ${m.state} — an active row needs an open milestone, a done row a closed one`,
			});
		}
	}

	if (focus.length > 1) {
		violations.push({
			code: "I6",
			message: `expected AT MOST ONE focus row in \`## Focus\`, found ${focus.length} — exclusive focus admits exactly one milestone`,
		});
	}
	for (const row of focus) {
		const where = row.declaredAt === "" ? "focus row" : `focus row (declared ${row.declaredAt})`;
		if (row.milestone === null) {
			violations.push({
				code: "I6",
				message: `${where} pins no milestone by number — a focus row must carry a \`#N\` pin`,
			});
			continue;
		}
		const m = byNumber.get(row.milestone);
		if (m === undefined) {
			violations.push({
				code: "I6",
				message: `${where} pins milestone #${row.milestone}, which does not exist`,
			});
			continue;
		}
		if (m.state !== "open") {
			violations.push({
				code: "I6",
				message: `${where} pins milestone #${m.number} ("${m.title}"), which is closed — a declared focus must be an open milestone`,
			});
		}
		// Requiring an ACTIVE claimer is what stops the focus pointing at a milestone the roadmap
		// retired or never adopted — pinned and open is not enough.
		if (!rows.some((r) => r.milestone === row.milestone && r.state === "active")) {
			violations.push({
				code: "I6",
				message: `${where} pins milestone #${m.number} ("${m.title}"), which is claimed by no active arc or campaign row`,
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
		focusCount: focus.length,
	};
};

/** The verb label every report below is prefixed with, and the verb's own refusals reuse. */
export const VERB = "guard roadmap-guard check";

/** The human report for a verdict. It names what was scanned, per ADR 0092. */
export const renderReport = (verdict: RoadmapVerdict): string => {
	if (verdict.pass) {
		const focus = verdict.focusCount === 0 ? "no exclusive focus declared" : "1 focus row declared";
		return (
			`${VERB}: in sync — ${verdict.arcCount} arc row(s) + ${verdict.campaignCount} campaign row(s) ` +
			`validated against ${verdict.milestoneCount} milestone(s), ${focus} (I1–I6 all green).`
		);
	}
	if (verdict.reason === "zero-scope") {
		return (
			`${VERB}: scanned ${verdict.arcCount} arc row(s) and ${verdict.milestoneCount} milestone(s) — ` +
			"zero scope on one side, fail-closed (ADR 0092, I4). Is ROADMAP.md's `## Arcs` table present and " +
			"are there milestones to project onto? A vacuous pass would hide real drift."
		);
	}
	const lines = verdict.violations.map((v) => `  [${v.code}] ${v.message}`);
	return (
		`${VERB}: ${verdict.violations.length} ROADMAP.md ↔ milestone drift violation(s):\n` +
		`${lines.join("\n")}\n\n` +
		"ROADMAP.md's `## Arcs`/`## Campaigns`/`## Focus` tables and the GitHub milestone projection have drifted.\n" +
		"Reconcile the offending row(s)/milestone(s) above (roadmap map #2620; invariants I1–I6, #2632/#2660/#5012)."
	);
};

/** A milestone cell (`#17`) resolved to its number, else `null`. */
export const parseMilestoneCell = (cell: string): number | null => {
	const m = cell.match(/#(\d+)/);
	return m?.[1] === undefined ? null : Number(m[1]);
};

/** One markdown table line split into trimmed cells, less the empty fields the outer pipes make. */
const splitRow = (line: string): ReadonlyArray<string> => {
	const cells = line.split("|").map((c) => c.trim());
	if (cells.length > 0 && cells[0] === "") cells.shift();
	if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
	return cells;
};

const isSeparatorRow = (cells: ReadonlyArray<string>): boolean =>
	cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));

/**
 * The data rows (header and `|---|` separator dropped) of the first table under `## <heading>`.
 *
 * `[]` for an absent heading or a tableless section — the caller turns an empty `## Arcs` into the I4
 * fail and an empty `## Campaigns` into a legal no-campaigns roadmap.
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
	i++;

	const rows: Array<ReadonlyArray<string>> = [];
	let seenTable = false;
	for (; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim();
		if (/^##\s+/.test(line)) break;
		if (!line.startsWith("|")) {
			// Prose before the table is preamble; the first non-table line after it ends the table.
			if (seenTable) break;
			continue;
		}
		seenTable = true;
		const cells = splitRow(line);
		if (isSeparatorRow(cells)) continue;
		rows.push(cells);
	}
	return rows.slice(1);
};

const toRow = (kind: RowKind, cells: ReadonlyArray<string>): RoadmapRow => ({
	kind,
	name: (cells[0] ?? "").trim(),
	milestone: parseMilestoneCell(cells[1] ?? ""),
	state: (cells[2] ?? "").trim().toLowerCase(),
});

/**
 * The `## Focus` table's rows.
 *
 * A row whose every cell is blank is a table artifact and is dropped; a row carrying a date but no
 * pin is KEPT, so I6 reds on it instead of it reading as nothing declared.
 */
export const parseFocus = (md: string): ReadonlyArray<FocusRow> =>
	parseSectionRows(md, "Focus")
		.map((cells) => ({
			milestone: parseMilestoneCell(cells[0] ?? ""),
			declaredAt: (cells[1] ?? "").trim(),
		}))
		.filter((r) => r.milestone !== null || r.declaredAt !== "");

/** The three tables. An arc or campaign row with an empty name is a table artifact, never a row. */
export const parseRoadmap = (
	md: string,
): {
	readonly arcs: ReadonlyArray<RoadmapRow>;
	readonly campaigns: ReadonlyArray<RoadmapRow>;
	readonly focus: ReadonlyArray<FocusRow>;
} => ({
	arcs: parseSectionRows(md, "Arcs")
		.map((cells) => toRow("arc", cells))
		.filter((r) => r.name !== ""),
	campaigns: parseSectionRows(md, "Campaigns")
		.map((cells) => toRow("campaign", cells))
		.filter((r) => r.name !== ""),
	focus: parseFocus(md),
});
