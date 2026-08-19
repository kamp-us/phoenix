/**
 * The parse of `ROADMAP.md`'s three tables and the I1–I6 verdict — each invariant's pass and every
 * way it fails, ported from v1's `roadmap-guard` (#2648). No IO: the file and the milestone
 * projection are crossed in `./roadmap-verb.ts`.
 */
import {describe, expect, it} from "vitest";
import {
	type FocusRow,
	judge,
	type Milestone,
	parseFocus,
	parseMilestoneCell,
	parseRoadmap,
	parseSectionRows,
	type RoadmapRow,
	type RoadmapVerdict,
	renderReport,
} from "./roadmap.ts";

const arc = (name: string, milestone: number | null, state: string): RoadmapRow => ({
	kind: "arc",
	name,
	milestone,
	state,
});
const campaign = (name: string, milestone: number | null, state: string): RoadmapRow => ({
	kind: "campaign",
	name,
	milestone,
	state,
});
const ms = (number: number, state: "open" | "closed", title = `m${number}`): Milestone => ({
	number,
	state,
	title,
});
const focusRow = (milestone: number | null, declaredAt = "2026-08-09"): FocusRow => ({
	milestone,
	declaredAt,
});

/** The violation codes a verdict carries — `[]` for a pass or a zero-scope fail. */
const codes = (v: RoadmapVerdict): ReadonlyArray<string> =>
	v.pass || v.reason === "zero-scope" ? [] : v.violations.map((x) => x.code);

/** The messages a verdict carries for one invariant. */
const messages = (v: RoadmapVerdict, code: string): ReadonlyArray<string> =>
	v.pass || v.reason === "zero-scope"
		? []
		: v.violations.filter((x) => x.code === code).map((x) => x.message);

// A well-formed roadmap: one active arc, queued arcs (one with a lazy pin), one active campaign.
const goodArcs = [
	arc("Four Pillars", 17, "active"),
	arc("Geçit", 24, "queued"),
	arc("Lazy", null, "queued"),
];
const goodCampaigns = [campaign("Mentor Audit", 27, "active")];
const goodMilestones = [ms(17, "open"), ms(24, "open"), ms(27, "open")];

describe("judge — happy path", () => {
	it("PASSES when I1–I4 all hold (arcs + campaigns + milestones in sync)", () => {
		const v = judge(goodArcs, goodCampaigns, goodMilestones);
		expect(v.pass).toBe(true);
		if (v.pass) {
			expect(v.arcCount).toBe(3);
			expect(v.campaignCount).toBe(1);
			expect(v.milestoneCount).toBe(3);
		}
	});

	it("tolerates a queued arc with NO milestone pin (lazy on activation, I1)", () => {
		expect(
			judge([arc("Now", 17, "active"), arc("Later", null, "queued")], [], [ms(17, "open")]).pass,
		).toBe(true);
	});

	it("resolves a done arc/campaign pinned to a CLOSED milestone (I1 reads all states)", () => {
		expect(
			judge(
				[arc("Now", 17, "active"), arc("Shipped", 10, "done")],
				[campaign("Past", 11, "done")],
				[ms(17, "open"), ms(10, "closed"), ms(11, "closed")],
			).pass,
		).toBe(true);
	});
});

describe("judge — I4 zero-scope fail-closed (ADR 0092)", () => {
	it("FAILS zero-scope on zero arc rows", () => {
		const v = judge([], goodCampaigns, goodMilestones);
		expect(v.pass).toBe(false);
		expect(v.pass === false && v.reason).toBe("zero-scope");
	});

	it("FAILS zero-scope on zero milestones", () => {
		const v = judge(goodArcs, goodCampaigns, []);
		expect(v.pass).toBe(false);
		expect(v.pass === false && v.reason).toBe("zero-scope");
	});
});

describe("judge — I1 pinned by number to an existing milestone", () => {
	it("FAILS I1 when a row's pin resolves to no milestone", () => {
		const v = judge([arc("Now", 17, "active"), arc("Ghost", 99, "queued")], [], [ms(17, "open")]);
		expect(messages(v, "I1").some((m) => m.includes("#99"))).toBe(true);
	});

	it("FAILS I1 when a NON-queued arc has no pin", () => {
		expect(codes(judge([arc("Now", null, "active")], [], [ms(1, "open")]))).toContain("I1");
	});

	it("FAILS I1 when a CAMPAIGN has no pin (campaigns have no lazy tolerance)", () => {
		const v = judge(
			[arc("Now", 17, "active")],
			[campaign("Unpinned", null, "active")],
			[ms(17, "open")],
		);
		expect(messages(v, "I1").some((m) => m.includes("Unpinned"))).toBe(true);
	});
});

describe("judge — I2 exactly one active arc", () => {
	it("FAILS I2 on zero active arcs", () => {
		const v = judge(
			[arc("A", 17, "queued"), arc("B", 24, "queued")],
			[],
			[ms(17, "open"), ms(24, "open")],
		);
		expect(messages(v, "I2").some((m) => m.includes("found 0"))).toBe(true);
	});

	it("FAILS I2 on two active arcs", () => {
		const v = judge(
			[arc("A", 17, "active"), arc("B", 24, "active")],
			[],
			[ms(17, "open"), ms(24, "open")],
		);
		expect(messages(v, "I2").some((m) => m.includes("found 2"))).toBe(true);
	});

	it("does NOT count active campaigns toward I2 (campaigns run concurrently)", () => {
		expect(
			judge(
				[arc("A", 17, "active")],
				[campaign("C1", 27, "active"), campaign("C2", 28, "active")],
				[ms(17, "open"), ms(27, "open"), ms(28, "open")],
			).pass,
		).toBe(true);
	});
});

describe("judge — I3 no unclaimed open milestone", () => {
	it("FAILS I3 when an open milestone is claimed by no row", () => {
		const v = judge([arc("Now", 17, "active")], [], [ms(17, "open"), ms(42, "open", "Orphan")]);
		expect(messages(v, "I3").some((m) => m.includes("#42"))).toBe(true);
	});

	it("does NOT fail I3 for an unclaimed CLOSED milestone (only open must be claimed)", () => {
		expect(judge([arc("Now", 17, "active")], [], [ms(17, "open"), ms(9, "closed")]).pass).toBe(
			true,
		);
	});

	it("counts a campaign row as a claimer of an open milestone", () => {
		expect(
			judge(
				[arc("Now", 17, "active")],
				[campaign("Aud", 27, "active")],
				[ms(17, "open"), ms(27, "open")],
			).pass,
		).toBe(true);
	});
});

describe("judge — I5 active↔done state symmetry (the campaign lifecycle, #2660)", () => {
	it("PASSES an active campaign over an OPEN milestone (the Mentor Audit #27 case)", () => {
		expect(
			judge(
				[arc("Four Pillars", 17, "active")],
				[campaign("Mentor Audit", 27, "active")],
				[ms(17, "open"), ms(27, "open", "Mentor Audit campaign")],
			).pass,
		).toBe(true);
	});

	it("PASSES a done campaign over a CLOSED milestone", () => {
		expect(
			judge(
				[arc("Four Pillars", 17, "active")],
				[campaign("Past Audit", 30, "done")],
				[ms(17, "open"), ms(30, "closed")],
			).pass,
		).toBe(true);
	});

	it("FAILS I5 when an ACTIVE campaign sits over a CLOSED milestone", () => {
		const v = judge(
			[arc("Four Pillars", 17, "active")],
			[campaign("Zombie", 27, "active")],
			[ms(17, "open"), ms(27, "closed")],
		);
		expect(messages(v, "I5").some((m) => m.includes("Zombie"))).toBe(true);
	});

	it("FAILS I5 when a DONE campaign sits over an OPEN milestone", () => {
		const v = judge(
			[arc("Four Pillars", 17, "active")],
			[campaign("Premature", 27, "done")],
			[ms(17, "open"), ms(27, "open")],
		);
		expect(messages(v, "I5").some((m) => m.includes("Premature"))).toBe(true);
	});

	it("applies symmetry to ARCS too: a done arc over an OPEN milestone FAILS I5", () => {
		const v = judge(
			[arc("Now", 17, "active"), arc("Shipped", 10, "done")],
			[],
			[ms(17, "open"), ms(10, "open")],
		);
		expect(messages(v, "I5").some((m) => m.includes("Shipped"))).toBe(true);
	});

	it("EXEMPTS a queued arc from symmetry (its milestone opens lazily on activation)", () => {
		expect(
			judge(
				[arc("Now", 17, "active"), arc("Later", 24, "queued")],
				[],
				[ms(17, "open"), ms(24, "closed")],
			).pass,
		).toBe(true);
	});

	it("does NOT double-report I5 for a dangling pin (that is an I1, not an I5)", () => {
		const v = judge([arc("Ghost", 99, "active")], [], [ms(17, "open")]);
		expect(codes(v)).toContain("I1");
		expect(codes(v)).not.toContain("I5");
	});
});

describe("judge — I6 the declared focus is honest (#5012)", () => {
	it("PASSES with NO focus row at all — no exclusive focus declared is the default", () => {
		const v = judge(goodArcs, goodCampaigns, goodMilestones, []);
		expect(v.pass).toBe(true);
		if (v.pass) expect(v.focusCount).toBe(0);
	});

	it("PASSES an omitted focus argument identically (an absent `## Focus` section)", () => {
		expect(judge(goodArcs, goodCampaigns, goodMilestones).pass).toBe(true);
	});

	it("PASSES one focus row over an open milestone claimed by an ACTIVE campaign", () => {
		const v = judge(goodArcs, goodCampaigns, goodMilestones, [focusRow(27)]);
		expect(v.pass).toBe(true);
		if (v.pass) expect(v.focusCount).toBe(1);
	});

	it("PASSES one focus row over an open milestone claimed by the ACTIVE arc", () => {
		expect(judge(goodArcs, goodCampaigns, goodMilestones, [focusRow(17)]).pass).toBe(true);
	});

	it("FAILS I6 on MORE THAN ONE focus row", () => {
		const v = judge(goodArcs, goodCampaigns, goodMilestones, [focusRow(17), focusRow(27)]);
		expect(messages(v, "I6").some((m) => m.includes("AT MOST ONE focus row"))).toBe(true);
	});

	it("FAILS I6 when the focus milestone DOES NOT RESOLVE", () => {
		expect(messages(judge(goodArcs, goodCampaigns, goodMilestones, [focusRow(99)]), "I6")).toEqual([
			"focus row (declared 2026-08-09) pins milestone #99, which does not exist",
		]);
	});

	it("FAILS I6 when the focus row carries no `#N` pin at all", () => {
		const v = judge(goodArcs, goodCampaigns, goodMilestones, [focusRow(null)]);
		expect(messages(v, "I6").some((m) => m.includes("pins no milestone by number"))).toBe(true);
	});

	it("FAILS I6 when the focus milestone is CLOSED", () => {
		const v = judge(
			[arc("Now", 17, "active"), arc("Old", 18, "done")],
			[],
			[ms(17, "open"), ms(18, "closed")],
			[focusRow(18)],
		);
		expect(messages(v, "I6").some((m) => m.includes("which is closed"))).toBe(true);
	});

	// #24 is pinned by a QUEUED arc — pinned, open, and still not a legal focus.
	it("FAILS I6 when the focus milestone is claimed by NO ACTIVE arc or campaign row", () => {
		expect(messages(judge(goodArcs, goodCampaigns, goodMilestones, [focusRow(24)]), "I6")).toEqual([
			'focus row (declared 2026-08-09) pins milestone #24 ("m24"), which is claimed by no active arc or campaign row',
		]);
	});

	it("still fails ZERO-SCOPE ahead of I6 — a focus row never buys a vacuous pass (ADR 0092)", () => {
		const v = judge([], goodCampaigns, [], [focusRow(27)]);
		expect(v.pass).toBe(false);
		if (!v.pass) expect(v.reason).toBe("zero-scope");
	});
});

describe("judge — row-state well-formedness (backstops I1/I2)", () => {
	it("FLAGS an unrecognized arc state", () => {
		const v = judge(
			[arc("Now", 17, "active"), arc("Typo", 24, "activ")],
			[],
			[ms(17, "open"), ms(24, "open")],
		);
		expect(codes(v)).toContain("row-state");
	});

	it("FLAGS a campaign in the illegal `queued` state", () => {
		const v = judge(
			[arc("Now", 17, "active")],
			[campaign("C", 27, "queued")],
			[ms(17, "open"), ms(27, "open")],
		);
		expect(messages(v, "row-state").some((m) => m.includes("queued"))).toBe(true);
	});
});

describe("judge — collects EVERY violation in one pass", () => {
	it("reports I1, I2, and I3 together", () => {
		const v = judge(
			// two active arcs (I2), one pinned to a missing milestone (I1)
			[arc("A", 17, "active"), arc("B", 99, "active")],
			[],
			// #42 open + unclaimed (I3)
			[ms(17, "open"), ms(42, "open")],
		);
		expect(new Set(codes(v))).toEqual(new Set(["I1", "I2", "I3"]));
	});
});

describe("renderReport", () => {
	it("names the passing scope", () => {
		const r = renderReport(judge(goodArcs, goodCampaigns, goodMilestones));
		expect(r).toContain("in sync");
		expect(r).toContain("3 arc row(s) + 1 campaign row(s) validated against 3 milestone(s)");
		expect(r).toContain("no exclusive focus declared (I1–I6 all green).");
	});

	it("names a declared focus in the passing summary", () => {
		expect(renderReport(judge(goodArcs, goodCampaigns, goodMilestones, [focusRow(17)]))).toContain(
			"1 focus row declared",
		);
	});

	it("explains the fail-closed zero-scope verdict", () => {
		const r = renderReport(judge([], goodCampaigns, goodMilestones));
		expect(r).toContain("fail-closed");
		expect(r).toContain("ADR 0092");
	});

	it("lists each violation with its invariant code", () => {
		// Ghost is pinned to #99 (absent) ⇒ I1; #17 open + unclaimed ⇒ I3.
		const r = renderReport(judge([arc("Ghost", 99, "active")], [], [ms(17, "open")]));
		expect(r).toContain("[I1]");
		expect(r).toContain("[I3]");
	});
});

describe("parseMilestoneCell", () => {
	it("extracts #N", () => {
		expect(parseMilestoneCell("#17")).toBe(17);
		expect(parseMilestoneCell(" #24 ")).toBe(24);
	});

	it("returns null for a blank/dashed cell (a queued arc's deferred pin)", () => {
		expect(parseMilestoneCell("")).toBeNull();
		expect(parseMilestoneCell("—")).toBeNull();
	});
});

describe("parseSectionRows + parseRoadmap", () => {
	const md = [
		"# Roadmap",
		"",
		"## Arcs",
		"",
		"| Arc | Milestone | State |",
		"|-----|-----------|-------|",
		"| Four Pillars | #17 | active |",
		"| Geçit | #24 | queued |",
		"| Lazy | | queued |",
		"",
		"Prose after the table is ignored.",
		"",
		"## Campaigns",
		"",
		"| Campaign | Milestone | State |",
		"|----------|-----------|-------|",
		"| Mentor Audit | #27 | active |",
		"",
		"## Focus",
		"",
		"| Milestone | Declared |",
		"|-----------|----------|",
		"| #27 | 2026-08-09 |",
		"",
		"## Standing lanes",
		"",
		"Not a table.",
	].join("\n");

	it("drops the header + separator, keeps only data rows", () => {
		const rows = parseSectionRows(md, "Arcs");
		expect(rows.length).toBe(3);
		expect(rows[0]?.[0]).toBe("Four Pillars");
	});

	it("parses arcs and campaigns into rows with pins + lowercased states", () => {
		const {arcs, campaigns} = parseRoadmap(md);
		expect(arcs).toEqual([
			{kind: "arc", name: "Four Pillars", milestone: 17, state: "active"},
			{kind: "arc", name: "Geçit", milestone: 24, state: "queued"},
			{kind: "arc", name: "Lazy", milestone: null, state: "queued"},
		]);
		expect(campaigns).toEqual([
			{kind: "campaign", name: "Mentor Audit", milestone: 27, state: "active"},
		]);
	});

	it("parses the focus table into at most one row with its pin + declared-at date", () => {
		expect(parseRoadmap(md).focus).toEqual([{milestone: 27, declaredAt: "2026-08-09"}]);
	});

	it("the parsed roadmap PASSES judge against a matching milestone projection", () => {
		const {arcs, campaigns, focus} = parseRoadmap(md);
		expect(
			judge(arcs, campaigns, [ms(17, "open"), ms(24, "open"), ms(27, "open")], focus).pass,
		).toBe(true);
	});

	it("returns [] for an absent section", () => {
		expect(parseSectionRows(md, "Nonexistent")).toEqual([]);
		const {campaigns} = parseRoadmap(
			"## Arcs\n\n| Arc | Milestone | State |\n|-|-|-|\n| A | #1 | active |",
		);
		expect(campaigns).toEqual([]);
	});
});

describe("parseFocus — absence and emptiness both mean NO exclusive focus (#5012)", () => {
	it("returns [] for an ABSENT `## Focus` section", () => {
		expect(parseFocus("# Roadmap\n\n## Arcs\n\n| Arc | Milestone | State |\n|-|-|-|\n")).toEqual(
			[],
		);
	});

	it("returns [] for a PRESENT but header-only `## Focus` table", () => {
		expect(parseFocus("## Focus\n\n| Milestone | Declared |\n|-----------|----------|\n")).toEqual(
			[],
		);
	});

	it("returns [] for a `## Focus` section carrying prose and no table", () => {
		expect(parseFocus("## Focus\n\nNo exclusive focus is declared right now.\n")).toEqual([]);
	});

	it("keeps a dated row with NO pin so I6 can red on it, rather than reading it as no focus", () => {
		expect(parseFocus("## Focus\n\n| Milestone | Declared |\n|-|-|\n| | 2026-08-09 |\n")).toEqual([
			{milestone: null, declaredAt: "2026-08-09"},
		]);
	});

	it("parses every row so I6 sees the over-declaration rather than only the first", () => {
		expect(
			parseFocus(
				"## Focus\n\n| Milestone | Declared |\n|-|-|\n| #44 | 2026-08-09 |\n| #27 | 2026-08-01 |\n",
			).length,
		).toBe(2);
	});
});
