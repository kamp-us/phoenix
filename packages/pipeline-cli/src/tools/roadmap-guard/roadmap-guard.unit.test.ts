/**
 * Pure-core tests for `roadmap-guard` (#2648, roadmap map #2620): the parse of
 * ROADMAP.md's `## Arcs`/`## Campaigns` tables and the I1–I5 verdict (each invariant's
 * pass + every failure mode, plus the zero-scope fail-closed of ADR 0092 and the
 * active↔done state symmetry of #2660). No IO — the `gh api`/filesystem seam is crossed
 * in `gate.ts`/`github.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	judge,
	type Milestone,
	parseMilestoneCell,
	parseRoadmap,
	parseSectionRows,
	type RoadmapRow,
	renderReport,
} from "./roadmap-guard.ts";

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

// A well-formed roadmap: one active arc + queued arcs (some with lazy pins) + one active
// campaign, every pin resolving, every open milestone claimed.
const goodArcs = [
	arc("Four Pillars", 17, "active"),
	arc("Geçit", 24, "queued"),
	arc("Lazy", null, "queued"), // queued arc may defer its milestone (I1 tolerance)
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
		const v = judge([arc("Now", 17, "active"), arc("Later", null, "queued")], [], [ms(17, "open")]);
		expect(v.pass).toBe(true);
	});

	it("resolves a done arc/campaign pinned to a CLOSED milestone (I1 uses all states)", () => {
		const v = judge(
			[arc("Now", 17, "active"), arc("Shipped", 10, "done")],
			[campaign("Past", 11, "done")],
			[ms(17, "open"), ms(10, "closed"), ms(11, "closed")],
		);
		expect(v.pass).toBe(true);
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

describe("judge — I1 arc/campaign pinned by number to an existing milestone", () => {
	it("FAILS I1 when a row's pin resolves to no milestone", () => {
		const v = judge([arc("Now", 17, "active"), arc("Ghost", 99, "queued")], [], [ms(17, "open")]);
		expect(v.pass).toBe(false);
		if (v.pass === false && v.reason === "violations") {
			expect(v.violations.some((x) => x.code === "I1" && x.message.includes("#99"))).toBe(true);
		} else {
			throw new Error("expected a violations verdict");
		}
	});

	it("FAILS I1 when a NON-queued arc has no pin", () => {
		const v = judge([arc("Now", null, "active")], [], [ms(1, "open")]);
		expect(v.pass).toBe(false);
		if (v.pass === false && v.reason === "violations") {
			expect(v.violations.some((x) => x.code === "I1")).toBe(true);
		} else {
			throw new Error("expected a violations verdict");
		}
	});

	it("FAILS I1 when a CAMPAIGN has no pin (campaigns have no lazy tolerance)", () => {
		const v = judge(
			[arc("Now", 17, "active")],
			[campaign("Unpinned", null, "active")],
			[ms(17, "open")],
		);
		expect(v.pass).toBe(false);
		if (v.pass === false && v.reason === "violations") {
			expect(v.violations.some((x) => x.code === "I1" && x.message.includes("Unpinned"))).toBe(
				true,
			);
		} else {
			throw new Error("expected a violations verdict");
		}
	});
});

describe("judge — I2 exactly one active arc", () => {
	it("FAILS I2 on zero active arcs", () => {
		const v = judge(
			[arc("A", 17, "queued"), arc("B", 24, "queued")],
			[],
			[ms(17, "open"), ms(24, "open")],
		);
		expect(v.pass).toBe(false);
		if (v.pass === false && v.reason === "violations") {
			expect(v.violations.some((x) => x.code === "I2" && x.message.includes("found 0"))).toBe(true);
		} else {
			throw new Error("expected a violations verdict");
		}
	});

	it("FAILS I2 on two active arcs", () => {
		const v = judge(
			[arc("A", 17, "active"), arc("B", 24, "active")],
			[],
			[ms(17, "open"), ms(24, "open")],
		);
		expect(v.pass).toBe(false);
		if (v.pass === false && v.reason === "violations") {
			expect(v.violations.some((x) => x.code === "I2" && x.message.includes("found 2"))).toBe(true);
		} else {
			throw new Error("expected a violations verdict");
		}
	});

	it("does NOT count active campaigns toward I2 (campaigns run concurrently)", () => {
		const v = judge(
			[arc("A", 17, "active")],
			[campaign("C1", 27, "active"), campaign("C2", 28, "active")],
			[ms(17, "open"), ms(27, "open"), ms(28, "open")],
		);
		expect(v.pass).toBe(true);
	});
});

describe("judge — I3 no unclaimed open milestone", () => {
	it("FAILS I3 when an open milestone is claimed by no row", () => {
		const v = judge([arc("Now", 17, "active")], [], [ms(17, "open"), ms(42, "open", "Orphan")]);
		expect(v.pass).toBe(false);
		if (v.pass === false && v.reason === "violations") {
			expect(v.violations.some((x) => x.code === "I3" && x.message.includes("#42"))).toBe(true);
		} else {
			throw new Error("expected a violations verdict");
		}
	});

	it("does NOT fail I3 for an unclaimed CLOSED milestone (only open must be claimed)", () => {
		const v = judge([arc("Now", 17, "active")], [], [ms(17, "open"), ms(9, "closed")]);
		expect(v.pass).toBe(true);
	});

	it("counts a campaign row as a claimer of an open milestone", () => {
		const v = judge(
			[arc("Now", 17, "active")],
			[campaign("Aud", 27, "active")],
			[ms(17, "open"), ms(27, "open")],
		);
		expect(v.pass).toBe(true);
	});
});

describe("judge — I5 active↔done state symmetry (the campaign lifecycle, #2660)", () => {
	it("PASSES an active campaign over an OPEN milestone (the Mentor Audit #27 validation case)", () => {
		const v = judge(
			[arc("Four Pillars", 17, "active")],
			[campaign("Mentor Audit", 27, "active")],
			[ms(17, "open"), ms(27, "open", "Mentor Audit campaign")],
		);
		expect(v.pass).toBe(true);
	});

	it("PASSES a done campaign over a CLOSED milestone", () => {
		const v = judge(
			[arc("Four Pillars", 17, "active")],
			[campaign("Past Audit", 30, "done")],
			[ms(17, "open"), ms(30, "closed")],
		);
		expect(v.pass).toBe(true);
	});

	it("FAILS I5 when an ACTIVE campaign sits over a CLOSED milestone", () => {
		const v = judge(
			[arc("Four Pillars", 17, "active")],
			[campaign("Zombie", 27, "active")],
			[ms(17, "open"), ms(27, "closed")],
		);
		expect(v.pass).toBe(false);
		if (v.pass === false && v.reason === "violations") {
			expect(v.violations.some((x) => x.code === "I5" && x.message.includes("Zombie"))).toBe(true);
		} else {
			throw new Error("expected a violations verdict");
		}
	});

	it("FAILS I5 when a DONE campaign sits over an OPEN milestone", () => {
		const v = judge(
			[arc("Four Pillars", 17, "active")],
			[campaign("Premature", 27, "done")],
			[ms(17, "open"), ms(27, "open")],
		);
		expect(v.pass).toBe(false);
		if (v.pass === false && v.reason === "violations") {
			expect(v.violations.some((x) => x.code === "I5" && x.message.includes("Premature"))).toBe(
				true,
			);
		} else {
			throw new Error("expected a violations verdict");
		}
	});

	it("applies symmetry to ARCS too: a done arc over an OPEN milestone FAILS I5", () => {
		const v = judge(
			[arc("Now", 17, "active"), arc("Shipped", 10, "done")],
			[],
			[ms(17, "open"), ms(10, "open")],
		);
		expect(v.pass).toBe(false);
		if (v.pass === false && v.reason === "violations") {
			expect(v.violations.some((x) => x.code === "I5" && x.message.includes("Shipped"))).toBe(true);
		} else {
			throw new Error("expected a violations verdict");
		}
	});

	it("EXEMPTS a queued arc from symmetry (its milestone opens lazily on activation)", () => {
		// A queued arc pinned to a still-closed milestone is legal — no active/done expectation.
		const v = judge(
			[arc("Now", 17, "active"), arc("Later", 24, "queued")],
			[],
			[ms(17, "open"), ms(24, "closed")],
		);
		expect(v.pass).toBe(true);
	});

	it("does NOT double-report I5 for a dangling pin (that is an I1, not an I5)", () => {
		const v = judge([arc("Ghost", 99, "active")], [], [ms(17, "open")]);
		expect(v.pass).toBe(false);
		if (v.pass === false && v.reason === "violations") {
			expect(v.violations.some((x) => x.code === "I1")).toBe(true);
			expect(v.violations.some((x) => x.code === "I5")).toBe(false);
		} else {
			throw new Error("expected a violations verdict");
		}
	});
});

describe("judge — row-state well-formedness (backstops I1/I2)", () => {
	it("FLAGS an unrecognized arc state", () => {
		const v = judge(
			[arc("Now", 17, "active"), arc("Typo", 24, "activ")],
			[],
			[ms(17, "open"), ms(24, "open")],
		);
		expect(v.pass).toBe(false);
		if (v.pass === false && v.reason === "violations") {
			expect(v.violations.some((x) => x.code === "row-state")).toBe(true);
		} else {
			throw new Error("expected a violations verdict");
		}
	});

	it("FLAGS a campaign in the illegal `queued` state", () => {
		const v = judge(
			[arc("Now", 17, "active")],
			[campaign("C", 27, "queued")],
			[ms(17, "open"), ms(27, "open")],
		);
		expect(v.pass).toBe(false);
		if (v.pass === false && v.reason === "violations") {
			expect(v.violations.some((x) => x.code === "row-state" && x.message.includes("queued"))).toBe(
				true,
			);
		} else {
			throw new Error("expected a violations verdict");
		}
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
		expect(v.pass).toBe(false);
		if (v.pass === false && v.reason === "violations") {
			const codes = new Set(v.violations.map((x) => x.code));
			expect(codes.has("I1")).toBe(true);
			expect(codes.has("I2")).toBe(true);
			expect(codes.has("I3")).toBe(true);
		} else {
			throw new Error("expected a violations verdict");
		}
	});
});

describe("renderReport", () => {
	it("names the passing scope", () => {
		expect(renderReport(judge(goodArcs, goodCampaigns, goodMilestones))).toContain("in sync");
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

	it("the parsed roadmap PASSES judge against a matching milestone projection", () => {
		const {arcs, campaigns} = parseRoadmap(md);
		const v = judge(arcs, campaigns, [ms(17, "open"), ms(24, "open"), ms(27, "open")]);
		expect(v.pass).toBe(true);
	});

	it("returns [] for an absent section", () => {
		expect(parseSectionRows(md, "Nonexistent")).toEqual([]);
		const {campaigns} = parseRoadmap(
			"## Arcs\n\n| Arc | Milestone | State |\n|-|-|-|\n| A | #1 | active |",
		);
		expect(campaigns).toEqual([]);
	});
});
