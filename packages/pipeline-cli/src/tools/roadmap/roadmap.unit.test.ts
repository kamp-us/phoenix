/**
 * Pure-core tests for `roadmap view` (#2651, roadmap map #2620 / steering seam #2639): the
 * label classification, PR→issue linkage parse, active-arc resolution, the stale-p1 drift
 * derivation, the tree assembly, and the render. No IO — the `gh api`/filesystem seam is crossed
 * in `view.ts`/`github.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	activeArc,
	buildView,
	deriveStaleP1s,
	type Issue,
	isEpic,
	type Milestone,
	type PullRequest,
	parseLinkedIssues,
	parseRoadmap,
	priorityOf,
	type RoadmapFacts,
	renderView,
} from "./roadmap.ts";

const issue = (n: number, over: Partial<Issue> = {}): Issue => ({
	number: n,
	title: `issue ${n}`,
	state: "open",
	labels: [],
	milestone: null,
	parent: null,
	isEpic: false,
	priority: null,
	...over,
});
const ms = (
	number: number,
	state: "open" | "closed" = "open",
	title = `m${number}`,
): Milestone => ({
	number,
	state,
	title,
});
const facts = (over: Partial<RoadmapFacts> = {}): RoadmapFacts => ({
	milestones: [],
	issues: [],
	pulls: [],
	...over,
});

describe("label classification", () => {
	it("isEpic reads the type:epic label", () => {
		expect(isEpic(["type:epic", "p1"])).toBe(true);
		expect(isEpic(["type:feature"])).toBe(false);
		expect(isEpic([])).toBe(false);
	});

	it("priorityOf picks the highest-urgency bucket present, else null", () => {
		expect(priorityOf(["p0", "p1"])).toBe("p0");
		expect(priorityOf(["type:feature", "p1"])).toBe("p1");
		expect(priorityOf(["p2"])).toBe("p2");
		expect(priorityOf(["type:chore"])).toBe(null);
	});
});

describe("parseLinkedIssues", () => {
	it("reads GitHub closing keywords from the body", () => {
		expect(parseLinkedIssues("Fixes #12 and closes #34", "")).toEqual([12, 34]);
		expect(parseLinkedIssues("resolved #7", "")).toEqual([7]);
	});

	it("reads the issue number off the branch name idiom", () => {
		expect(parseLinkedIssues("", "umut/2651-roadmap-view")).toEqual([2651]);
	});

	it("unions body + branch, de-duped", () => {
		expect(parseLinkedIssues("Fixes #2651", "umut/2651-roadmap-view")).toEqual([2651]);
	});

	it("returns [] when neither signal is present", () => {
		expect(parseLinkedIssues("no refs here", "main")).toEqual([]);
	});

	it("does not match a bare #N without a closing keyword (avoids false links)", () => {
		expect(parseLinkedIssues("see #99 for context", "")).toEqual([]);
	});
});

describe("activeArc", () => {
	const {arcs} = parseRoadmap(
		"## Arcs\n\n| Arc | Milestone | State |\n|--|--|--|\n" +
			"| Four Pillars | #17 | active |\n| Geçit | #24 | queued |\n",
	);

	it("resolves the single active arc row", () => {
		const a = activeArc(arcs);
		expect(a?.name).toBe("Four Pillars");
		expect(a?.milestone).toBe(17);
	});

	it("returns null when zero or several arcs are active (guard-owned, #2632)", () => {
		expect(activeArc([])).toBe(null);
		const two = parseRoadmap(
			"## Arcs\n\n| Arc | Milestone | State |\n|--|--|--|\n" +
				"| A | #1 | active |\n| B | #2 | active |\n",
		).arcs;
		expect(activeArc(two)).toBe(null);
	});
});

describe("deriveStaleP1s", () => {
	const issues = [
		issue(1, {priority: "p1", milestone: 17}), // in active milestone → not stale
		issue(2, {priority: "p1", milestone: 24}), // other milestone → stale
		issue(3, {priority: "p1", milestone: null}), // unmilestoned → stale
		issue(4, {priority: "p2", milestone: 24}), // not p1 → ignored
		issue(5, {priority: "p1", milestone: 24, state: "closed"}), // closed → ignored
	];

	it("flags open p1s outside the active-arc milestone", () => {
		expect(deriveStaleP1s(issues, 17).map((i) => i.number)).toEqual([2, 3]);
	});

	it("with no active milestone, every open p1 is stale (fail-loud)", () => {
		expect(deriveStaleP1s(issues, null).map((i) => i.number)).toEqual([1, 2, 3]);
	});

	it("counts a p1 epic parked off the active arc as drift", () => {
		const epic = issue(9, {priority: "p1", milestone: 24, isEpic: true});
		expect(deriveStaleP1s([epic], 17).map((i) => i.number)).toEqual([9]);
	});
});

const roadmapMd =
	"## Arcs\n\n| Arc | Milestone | State |\n|--|--|--|\n" +
	"| Four Pillars | #17 | active |\n| Geçit | #24 | queued |\n\n" +
	"## Campaigns\n\n| Campaign | Milestone | State |\n|--|--|--|\n" +
	"| Mentor Audit | #27 | active |\n";

describe("buildView — tree assembly", () => {
	const {arcs, campaigns} = parseRoadmap(roadmapMd);
	const epic = issue(100, {
		isEpic: true,
		milestone: 17,
		labels: ["type:epic"],
		title: "Pillars epic",
	});
	const child = issue(101, {parent: 100, milestone: 17, title: "a pillar child"});
	const loose = issue(102, {milestone: 17, title: "standalone in 17"});
	const p1Off = issue(200, {priority: "p1", milestone: 24, title: "off-arc p1"});
	const pr: PullRequest = {
		number: 500,
		title: "build the child",
		branch: "umut/101-x",
		linkedIssues: [101],
	};
	const view = buildView(
		arcs,
		campaigns,
		facts({milestones: [ms(17), ms(24), ms(27)], issues: [epic, child, loose, p1Off], pulls: [pr]}),
	);

	it("marks the active arc and resolves its milestone", () => {
		const fourPillars = view.arcs.find((r) => r.name === "Four Pillars");
		expect(fourPillars?.isActiveArc).toBe(true);
		expect(fourPillars?.milestone?.number).toBe(17);
		expect(view.activeMilestone).toBe(17);
	});

	it("hangs the epic tree, loose issue, and linked PR under the arc milestone", () => {
		const fourPillars = view.arcs.find((r) => r.name === "Four Pillars");
		expect(fourPillars?.epics.map((e) => e.epic.number)).toEqual([100]);
		expect(fourPillars?.epics[0]?.children.map((c) => c.number)).toEqual([101]);
		expect(fourPillars?.looseIssues.map((i) => i.number)).toEqual([102]);
		expect(fourPillars?.pulls.map((p) => p.number)).toEqual([500]);
	});

	it("renders campaigns and flags the off-arc p1 as stale", () => {
		expect(view.campaigns.map((c) => c.name)).toEqual(["Mentor Audit"]);
		expect(view.staleP1s.map((i) => i.number)).toEqual([200]);
	});

	it("does not treat a queued arc as active", () => {
		expect(view.arcs.find((r) => r.name === "Geçit")?.isActiveArc).toBe(false);
	});
});

describe("renderView", () => {
	const {arcs, campaigns} = parseRoadmap(roadmapMd);

	it("renders the header, the ACTIVE ARC marker, and a clean drift line", () => {
		const out = renderView(
			buildView(arcs, campaigns, facts({milestones: [ms(17), ms(24), ms(27)], issues: []})),
		);
		expect(out).toContain("active arc: Four Pillars");
		expect(out).toContain("← ACTIVE ARC");
		expect(out).toContain("no stale p1s");
	});

	it("renders a stale-p1 drift warning block when drift exists", () => {
		const out = renderView(
			buildView(
				arcs,
				campaigns,
				facts({
					milestones: [ms(17), ms(24), ms(27)],
					issues: [issue(200, {priority: "p1", milestone: 24, title: "off-arc p1"})],
				}),
			),
		);
		expect(out).toContain("⚠ Drift: 1 stale p1(s)");
		expect(out).toContain("#200 off-arc p1 (milestone #24)");
	});

	it("notes when no single arc is active", () => {
		const out = renderView(buildView([], [], facts()));
		expect(out).toContain("no single active arc");
	});
});
