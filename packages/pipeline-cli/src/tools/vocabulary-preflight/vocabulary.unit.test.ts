/**
 * Pure-core tests for `vocabulary-preflight` (#4272): the required set is assembled from the
 * tools' own constants (so it cannot drift from what it protects), an absent label universe is an
 * unmet prerequisite rather than a quiet pass, and the roadmap surface reds by the same path.
 * No IO — the `gh api` label read and the ROADMAP.md read are crossed in `gate.ts`/`github.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {ISSUE_TYPE_LABELS} from "../drive-issue-flow/type-route.ts";
import {EXEMPT_LABELS, TRIAGED_LABEL} from "../homing-guard/homing-guard.ts";
import {LANE_ENTERING_TYPES} from "../pitch-guard/pitch-guard.ts";
import {PRESENT, resolvePresence} from "./presence.ts";
import {
	judge,
	judgeRoadmap,
	LABEL_SPECS,
	REQUIRED_LABELS,
	type RoadmapSurface,
	renderLabelList,
	renderLabelSpecs,
	renderReport,
	SPECIFIED_LABELS,
	unspecifiedRequiredLabels,
} from "./vocabulary.ts";

const ROADMAP_OK: RoadmapSurface = {
	_tag: "present",
	path: "/repo/ROADMAP.md",
	arcs: 4,
	campaigns: 2,
};

describe("REQUIRED_LABELS", () => {
	it("covers every label the guards scope on", () => {
		for (const label of [TRIAGED_LABEL, ...EXEMPT_LABELS, ...LANE_ENTERING_TYPES]) {
			expect(REQUIRED_LABELS).toContain(label);
		}
	});

	it("covers the priority buckets and the whole pickability spine", () => {
		for (const label of ["p0", "p1", "p2", "status:needs-triage", "status:planned"]) {
			expect(REQUIRED_LABELS).toContain(label);
		}
	});

	it("dedupes a label that serves two concerns (axis:pipeline-hardening is lane AND platform)", () => {
		const hardening = REQUIRED_LABELS.filter((l) => l === "axis:pipeline-hardening");
		expect(hardening).toHaveLength(1);
	});

	it("names no label the six canonical types do not cover", () => {
		const types = REQUIRED_LABELS.filter((l) => l.startsWith("type:"));
		expect([...types].sort()).toEqual([...ISSUE_TYPE_LABELS].sort());
	});
});

describe("resolvePresence", () => {
	it("is present when the universe carries every required label", () => {
		expect(resolvePresence([TRIAGED_LABEL], [TRIAGED_LABEL, "p1"])).toEqual(PRESENT);
	});

	it("names exactly the labels the universe lacks", () => {
		expect(resolvePresence([TRIAGED_LABEL, "type:epic"], ["type:epic"])).toEqual({
			_tag: "absent",
			missing: [TRIAGED_LABEL],
		});
	});

	it("reds on an EMPTY universe — unreadable and never-created are the same unmet prerequisite", () => {
		expect(resolvePresence([TRIAGED_LABEL], [])).toEqual({
			_tag: "absent",
			missing: [TRIAGED_LABEL],
		});
	});
});

describe("judgeRoadmap", () => {
	it("passes a roadmap that parses at least one arc", () => {
		expect(judgeRoadmap(ROADMAP_OK)).toBeNull();
	});

	it("names an absent ROADMAP.md, carrying the path it looked at", () => {
		const unmet = judgeRoadmap({_tag: "absent", path: "/repo/ROADMAP.md"});
		expect(unmet).toEqual({_tag: "roadmap", path: "/repo/ROADMAP.md", detail: "not found"});
	});

	it("names a ROADMAP.md that parses ZERO arcs — an empty roadmap is not a quiet one", () => {
		const unmet = judgeRoadmap({...ROADMAP_OK, arcs: 0});
		expect(unmet?._tag).toBe("roadmap");
		expect(unmet?.detail).toContain("ZERO");
	});
});

describe("judge", () => {
	it("passes when every label exists and the roadmap parses", () => {
		const verdict = judge([...REQUIRED_LABELS], ROADMAP_OK);
		expect(verdict.pass).toBe(true);
		expect(renderReport(verdict)).toContain("prerequisites met");
	});

	it("reds on a repo with NO labels at all, naming every one of them", () => {
		const verdict = judge([], ROADMAP_OK);
		expect(verdict.pass).toBe(false);
		if (verdict.pass) return;
		expect(verdict.unmet).toHaveLength(1);
		const [unmet] = verdict.unmet;
		expect(unmet?._tag).toBe("labels");
		expect(unmet?._tag === "labels" && unmet.missing).toEqual([...REQUIRED_LABELS]);
	});

	it("reds on a partially-adopted repo, naming only what is missing", () => {
		const verdict = judge(
			REQUIRED_LABELS.filter((l) => l !== TRIAGED_LABEL),
			ROADMAP_OK,
		);
		expect(verdict.pass).toBe(false);
		if (verdict.pass) return;
		expect(verdict.unmet).toEqual([{_tag: "labels", missing: [TRIAGED_LABEL]}]);
	});

	it("collects BOTH unmet prerequisites in one run, so one pass names all of them", () => {
		const verdict = judge([], {_tag: "absent", path: "/repo/ROADMAP.md"});
		expect(verdict.pass).toBe(false);
		if (verdict.pass) return;
		expect(verdict.unmet.map((u) => u._tag)).toEqual(["labels", "roadmap"]);
	});
});

describe("renderReport", () => {
	it("groups the missing labels by the concern each serves", () => {
		const report = renderReport(judge([], ROADMAP_OK));
		expect(report).toContain("pickability spine:");
		expect(report).toContain("priority buckets:");
		expect(report).toContain("standing lanes:");
	});

	it("says the vocabulary is not configurable — the remedy is to create the labels", () => {
		const report = renderReport(judge([], ROADMAP_OK));
		expect(report).toContain("gh label create");
		expect(report).toContain("not\nconfiguration");
	});
});

describe("renderLabelList — the seam doctor.sh reads (#4300)", () => {
	it("emits one label per line and nothing else, so a `while read` consumer needs no parser", () => {
		const lines = renderLabelList(REQUIRED_LABELS).split("\n");
		expect(lines).toEqual([...REQUIRED_LABELS]);
	});

	// The list is doctor's Tier-1 floor, so an empty render would let doctor's drift check pass
	// against nothing — the vacuous-scope shape of ADR 0092, one surface over.
	it("is non-empty and carries the standing lanes doctor was missing", () => {
		const lines = renderLabelList(REQUIRED_LABELS).split("\n");
		expect(lines.length).toBeGreaterThan(0);
		for (const lane of EXEMPT_LABELS) expect(lines).toContain(lane);
	});
});

describe("LABEL_SPECS — the ONE colour/description home (#4341)", () => {
	it("can create every label the preflight enforces — the property that keeps the two aligned", () => {
		expect(unspecifiedRequiredLabels()).toEqual([]);
	});

	it("renders NAME|HEX|DESCRIPTION lines a bash `while IFS='|' read` consumes with no parser", () => {
		const lines = renderLabelSpecs(LABEL_SPECS).split("\n");
		expect(lines).toHaveLength(LABEL_SPECS.length);
		for (const line of lines) expect(line.split("|")).toHaveLength(3);
		expect(lines[0]).toBe(
			`${LABEL_SPECS[0]?.name}|${LABEL_SPECS[0]?.color}|${LABEL_SPECS[0]?.description}`,
		);
	});

	it("is non-empty — an empty table would let doctor print zero fixes and call it clean", () => {
		expect(LABEL_SPECS.length).toBeGreaterThan(0);
		expect(SPECIFIED_LABELS.length).toBeGreaterThanOrEqual(REQUIRED_LABELS.length);
	});
});
