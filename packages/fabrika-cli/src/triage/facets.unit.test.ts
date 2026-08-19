import {describe, expect, it} from "vitest";
import {
	AUDIENCES,
	type Change,
	decodeMember,
	PRIORITIES,
	parkedFacets,
	planReconcile,
	renderShape,
	STANDING_LANES,
	shapeViolations,
	TYPES,
	triagedFacets,
} from "./facets.ts";

const triaged = triagedFacets({
	type: "bug",
	priority: "p2",
	readyFor: "agent",
	lane: null,
});

const removedLabels = (changes: ReadonlyArray<Change>): ReadonlyArray<string> =>
	changes.flatMap((c) => (c._tag === "RemoveLabel" ? [c.label] : []));

const addedLabels = (changes: ReadonlyArray<Change>): ReadonlyArray<string> =>
	changes.flatMap((c) => (c._tag === "AddLabels" ? [...c.labels] : []));

describe("the containment invariant", () => {
	// #4285's mechanism was a facet owning MORE than its input can produce, so a correct value read
	// as superseded. Every case below re-derives that the pattern and the vocabulary line up, rather
	// than trusting the note in facets.ts that says so.
	it.each(TYPES)("keeps type:%s under the facet that owns type:*", (type) => {
		const facets = triagedFacets({type, priority: "p2", readyFor: "agent", lane: null});
		const facet = facets.find((f) => f.name === "type");
		expect(facet?.keep).toEqual([`type:${type}`]);
		expect(facet?.owns(`type:${type}`)).toBe(true);
	});

	it.each(PRIORITIES)("keeps %s under the facet that owns /^p\\d+$/", (priority) => {
		const facets = triagedFacets({type: "bug", priority, readyFor: "agent", lane: null});
		const facet = facets.find((f) => f.name === "priority");
		expect(facet?.keep).toEqual([priority]);
		expect(facet?.owns(priority)).toBe(true);
	});

	it.each(AUDIENCES)("keeps ready-for:%s under the facet that owns ready-for:*", (readyFor) => {
		const facets = triagedFacets({type: "bug", priority: "p2", readyFor, lane: null});
		const facet = facets.find((f) => f.name === "audience");
		expect(facet?.keep).toEqual([`ready-for:${readyFor}`]);
		expect(facet?.owns(`ready-for:${readyFor}`)).toBe(true);
	});

	it.each(STANDING_LANES)("keeps %s under the facet that owns the standing lanes", (lane) => {
		const facets = triagedFacets({type: "bug", priority: "p2", readyFor: "agent", lane});
		const facet = facets.find((f) => f.name === "lane");
		expect(facet?.keep).toEqual([lane]);
		expect(facet?.owns(lane)).toBe(true);
	});

	it("holds for every keep label of every facet, in both tables", () => {
		const tables = [
			triagedFacets({type: "epic", priority: "p0", readyFor: "human", lane: "wayfinder:backlog"}),
			parkedFacets(),
		];
		for (const table of tables) {
			for (const facet of table) {
				for (const label of facet.keep) expect(facet.owns(label)).toBe(true);
			}
		}
	});

	it("owns status:needs-info as a status, so a park and a triage contradict rather than coexist", () => {
		const status = triaged.find((f) => f.name === "status");
		expect(status?.owns("status:needs-info")).toBe(true);
		expect(status?.owns("status:needs-triage")).toBe(true);
		expect(status?.keep).toEqual(["status:triaged"]);
	});
});

describe("decodeMember", () => {
	it("returns the value when it is on the vocabulary", () => {
		expect(decodeMember(PRIORITIES, "p1")).toBe("p1");
	});

	it("returns null for a value off it — never the raw string", () => {
		expect(decodeMember(PRIORITIES, "1")).toBeNull();
		expect(decodeMember(TYPES, "type:bug")).toBeNull();
		expect(decodeMember(AUDIENCES, "")).toBeNull();
	});

	// The lanes are an open set once they are configuration (#6294), so the refusal is this decode
	// against the resolved list rather than a compile-time narrowing.
	it("recognises exactly the lanes it is handed, and nothing adjacent", () => {
		expect(decodeMember(STANDING_LANES, "wayfinder:backlog")).toBe("wayfinder:backlog");
		expect(decodeMember(STANDING_LANES, "axis:pipeline-hardening")).toBe("axis:pipeline-hardening");
		expect(decodeMember(STANDING_LANES, "wayfinder:backlog ")).toBeNull();
		expect(decodeMember(["team:infra"], "wayfinder:backlog")).toBeNull();
	});
});

describe("planReconcile — the #4285 removal mechanism", () => {
	it("removes a superseded priority and adds the applied one", () => {
		const plan = planReconcile(
			{labels: ["p1", "status:needs-triage"], milestone: null},
			triaged,
			47,
		);
		expect(plan.removed).toEqual(["p1", "status:needs-triage"]);
		expect(plan.added).toEqual(["type:bug", "p2", "status:triaged", "ready-for:agent"]);
	});

	it("NEVER removes the label it is applying, even when the facet's pattern matches it", () => {
		// The exact #4285 delete: `p2` matches /^p\d+$/, so a keep set the removal does not consult
		// strips the priority the run just asked for while still printing a success line.
		const plan = planReconcile({labels: ["p2", "type:bug"], milestone: 47}, triaged, 47);
		expect(plan.removed).not.toContain("p2");
		expect(plan.removed).not.toContain("type:bug");
		expect(removedLabels(plan.changes)).toEqual([]);
	});

	it("preserves every label no facet owns, and issues no write for it", () => {
		const plan = planReconcile(
			{labels: ["area:pipeline", "good first issue", "p1"], milestone: 47},
			triaged,
			47,
		);
		expect(plan.preserved).toEqual(["area:pipeline", "good first issue"]);
		expect(removedLabels(plan.changes)).toEqual(["p1"]);
		expect(addedLabels(plan.changes)).not.toContain("area:pipeline");
	});

	it("plans the milestone FIRST, so the homing guard never sees a triaged un-homed issue", () => {
		const plan = planReconcile({labels: ["status:needs-triage"], milestone: null}, triaged, 47);
		expect(plan.changes[0]).toEqual({_tag: "SetMilestone", milestone: 47});
	});

	it("plans every removal before the single add batch", () => {
		const plan = planReconcile({labels: ["p1", "status:needs-triage"], milestone: 47}, triaged, 47);
		const lastRemoval = plan.changes.findLastIndex((c) => c._tag === "RemoveLabel");
		const add = plan.changes.findIndex((c) => c._tag === "AddLabels");
		expect(lastRemoval).toBeGreaterThanOrEqual(0);
		expect(add).toBeGreaterThan(lastRemoval);
	});

	it("batches the adds into one change, because it is one API call", () => {
		const plan = planReconcile({labels: [], milestone: 47}, triaged, 47);
		expect(plan.changes.filter((c) => c._tag === "AddLabels")).toHaveLength(1);
	});

	it("plans nothing at all when the issue already holds the target shape", () => {
		const plan = planReconcile(
			{labels: ["type:bug", "p2", "status:triaged", "ready-for:agent"], milestone: 47},
			triaged,
			47,
		);
		expect(plan.changes).toEqual([]);
	});

	it("clears the milestone when the home is a standing lane (ADR 0208)", () => {
		const facets = triagedFacets({
			type: "chore",
			priority: "p2",
			readyFor: "agent",
			lane: "axis:pipeline-hardening",
		});
		const plan = planReconcile({labels: [], milestone: 47}, facets, null);
		expect(plan.changes[0]).toEqual({_tag: "ClearMilestone"});
		expect(plan.added).toContain("axis:pipeline-hardening");
	});

	it("touches the milestone not at all when the home already matches", () => {
		const plan = planReconcile({labels: [], milestone: 47}, triaged, 47);
		expect(plan.changes.some((c) => c._tag === "SetMilestone" || c._tag === "ClearMilestone")).toBe(
			false,
		);
	});

	it("swaps the other standing lane out rather than letting both stand", () => {
		const facets = triagedFacets({
			type: "chore",
			priority: "p2",
			readyFor: "agent",
			lane: "axis:pipeline-hardening",
		});
		const plan = planReconcile({labels: ["wayfinder:backlog"], milestone: null}, facets, null);
		expect(plan.removed).toEqual(["wayfinder:backlog"]);
		expect(plan.added).toContain("axis:pipeline-hardening");
	});
});

describe("planReconcile — a park", () => {
	const parked = parkedFacets();

	it("strips every priced facet and leaves only the parked status", () => {
		const plan = planReconcile(
			{
				labels: ["type:bug", "p1", "status:triaged", "ready-for:agent", "wayfinder:backlog"],
				milestone: 47,
			},
			parked,
			null,
		);
		expect(plan.removed).toEqual([
			"type:bug",
			"p1",
			"status:triaged",
			"ready-for:agent",
			"wayfinder:backlog",
		]);
		expect(plan.added).toEqual(["status:needs-info"]);
		expect(plan.changes[0]).toEqual({_tag: "ClearMilestone"});
	});

	it("preserves an unowned label across a park", () => {
		const plan = planReconcile({labels: ["area:pipeline"], milestone: null}, parked, null);
		expect(plan.preserved).toEqual(["area:pipeline"]);
		expect(removedLabels(plan.changes)).toEqual([]);
	});

	it("is idempotent on an already-parked issue", () => {
		const plan = planReconcile({labels: ["status:needs-info"], milestone: null}, parked, null);
		expect(plan.changes).toEqual([]);
	});
});

describe("shapeViolations — the read-back's positive proof", () => {
	it("names nothing when every facet holds exactly its keep set", () => {
		const observed = {
			labels: ["type:bug", "p2", "status:triaged", "ready-for:agent", "area:pipeline"],
			milestone: 47,
		};
		expect(shapeViolations(observed, triaged, 47)).toEqual([]);
	});

	it("fails a read that sees NOTHING — absence is not a matching shape", () => {
		expect(shapeViolations({labels: [], milestone: null}, triaged, 47)).toEqual([
			"type",
			"priority",
			"status",
			"audience",
			"milestone",
		]);
	});

	it("fails an issue reading both status labels at once", () => {
		const observed = {
			labels: ["type:bug", "p2", "status:triaged", "status:needs-info", "ready-for:agent"],
			milestone: 47,
		};
		expect(shapeViolations(observed, triaged, 47)).toEqual(["status"]);
	});

	it("fails a second priority alongside the applied one", () => {
		const observed = {
			labels: ["type:bug", "p2", "p0", "status:triaged", "ready-for:agent"],
			milestone: 47,
		};
		expect(shapeViolations(observed, triaged, 47)).toEqual(["priority"]);
	});

	it("names the milestone when the home did not land", () => {
		const observed = {
			labels: ["type:bug", "p2", "status:triaged", "ready-for:agent"],
			milestone: null,
		};
		expect(shapeViolations(observed, triaged, 47)).toEqual(["milestone"]);
	});

	it("names the milestone when a lane-exempt issue is still homed (ADR 0208)", () => {
		const facets = triagedFacets({
			type: "chore",
			priority: "p2",
			readyFor: "agent",
			lane: "wayfinder:backlog",
		});
		const observed = {
			labels: ["type:chore", "p2", "status:triaged", "ready-for:agent", "wayfinder:backlog"],
			milestone: 47,
		};
		expect(shapeViolations(observed, facets, null)).toEqual(["milestone"]);
	});

	it("fails a park whose read-back still carries a priced facet", () => {
		const parked = parkedFacets();
		expect(
			shapeViolations({labels: ["status:needs-info", "p1"], milestone: null}, parked, null),
		).toEqual(["priority"]);
	});

	it("ignores unowned labels entirely", () => {
		const observed = {
			labels: ["type:bug", "p2", "status:triaged", "ready-for:agent", "good first issue"],
			milestone: 47,
		};
		expect(shapeViolations(observed, triaged, 47)).toEqual([]);
	});
});

describe("renderShape", () => {
	it("reports what was seen facet by facet, including the milestone", () => {
		const observed = {labels: ["type:bug", "p1", "p2", "area:x"], milestone: 47};
		expect(renderShape(observed, triaged)).toBe(
			"type=[type:bug], priority=[p1, p2], status=[], audience=[], lane=[], milestone=47",
		);
	});

	it("says none for an unhomed issue rather than printing nothing", () => {
		expect(renderShape({labels: [], milestone: null}, triaged)).toContain("milestone=none");
	});
});
