import {describe, expect, it} from "vitest";
import {normalizeIssueType, routeIssueType, unroutableResult} from "./type-route.ts";

const lane = (raw: unknown) => {
	const r = routeIssueType(raw);
	return r.routed ? r.lane : "abort";
};

describe("routeIssueType — every canonical type names its lane (issue #4113)", () => {
	it("routes type:epic to the planner", () => {
		expect(lane("type:epic")).toBe("planner");
	});

	it("routes type:decision to the adr agent, never a coder (the #4045 mis-route)", () => {
		expect(lane("type:decision")).toBe("adr");
	});

	it("routes type:feature / type:chore / type:bug to the coder", () => {
		expect(lane("type:feature")).toBe("coder");
		expect(lane("type:chore")).toBe("coder");
		expect(lane("type:bug")).toBe("coder");
	});

	it("routes type:investigation to the coder as a NAMED branch, with its justification carried", () => {
		const r = routeIssueType("type:investigation");
		expect(r.routed).toBe(true);
		expect(lane("type:investigation")).toBe("coder");
		// AC: the choice is justified in the code, not an unnamed fall-through — the reason
		// names write-code's ownership of the diagnosis outcomes (ADR 0070's bounded collapse).
		expect(r.routed && r.reason).toMatch(/ADR 0070/);
		expect(r.routed && r.reason).toMatch(/not a fall-through/);
	});
});

describe("normalizeIssueType — tolerant read, strict decide", () => {
	it("accepts the bare word, the prefixed label, casing, whitespace and backticks", () => {
		expect(normalizeIssueType("decision")).toBe("decision");
		expect(normalizeIssueType("  TYPE:Decision  ")).toBe("decision");
		expect(normalizeIssueType("`type:decision`")).toBe("decision");
		expect(normalizeIssueType('"type: decision"')).toBe("decision");
	});

	it("normalizes anything unreadable to the empty string", () => {
		expect(normalizeIssueType(undefined)).toBe("");
		expect(normalizeIssueType(null)).toBe("");
		expect(normalizeIssueType(42)).toBe("");
		expect(normalizeIssueType({type: "decision"})).toBe("");
		expect(normalizeIssueType("   ")).toBe("");
	});
});

// The whole point of the guard: fail-closed means REFUSE TO DISPATCH, never "dispatch the coder
// anyway". Every unreadable/unknown case must land on the abort arm.
describe("routeIssueType — fail-closed on every unreadable or unknown type (issue #4113 AC)", () => {
	const unreadable: ReadonlyArray<readonly [string, unknown]> = [
		["a missing type (undefined)", undefined],
		["an explicit null", null],
		["an empty string", ""],
		["whitespace only", "   "],
		["a non-string number", 7],
		["a non-string object", {type: "type:bug"}],
		["a non-string array", ["type:bug"]],
		["a boolean", false],
		["an unknown type word", "type:spike"],
		["a status label mistaken for a type", "status:triaged"],
		["a priority label mistaken for a type", "p1"],
		["a wayfinder marker (not a type at all)", "wayfinder:map"],
		["two types at once — ambiguous, never guessed", "type:bug, type:decision"],
		["a near-miss plural", "type:decisions"],
		["a near-miss typo", "type:desicion"],
		["prose instead of a label", "the issue has no type label"],
	];

	for (const [name, raw] of unreadable) {
		it(`refuses to dispatch on ${name}`, () => {
			const r = routeIssueType(raw);
			expect(r.routed).toBe(false);
			expect(lane(raw)).toBe("abort");
			// no lane field exists on the abort arm — an abort can never be read as a coder lane
			expect(r).not.toHaveProperty("lane");
			expect(r.reason).not.toBe("");
		});
	}

	it("says WHY it refused — an absent type and an unknown type are distinguishable", () => {
		const absent = routeIssueType(undefined);
		const unknown = routeIssueType("type:spike");
		expect(absent.reason).toMatch(/no readable `type:\*` label/);
		expect(unknown.reason).toMatch(/unroutable issue type `type:spike`/);
		expect(absent.reason).not.toBe(unknown.reason);
	});
});

describe("unroutableResult — the structured, resumable terminal result (issue #4113 AC)", () => {
	it("is unambiguously separable from the other terminal shapes", () => {
		const r = routeIssueType("type:spike");
		expect(r.routed).toBe(false);
		if (r.routed) return;
		const out = unroutableResult(4113, r);
		expect(out).toMatchObject({unroutable: true, issue: 4113, type: "spike"});
		// none of `skipped` / `backedOff` / `frozen` / `aborted` — the shapes never collide
		expect(out).not.toHaveProperty("skipped");
		expect(out).not.toHaveProperty("backedOff");
		expect(out).not.toHaveProperty("frozen");
		expect(out).not.toHaveProperty("aborted");
		expect(out).not.toHaveProperty("pr");
	});

	it("carries the empty type through when nothing readable came back", () => {
		const r = routeIssueType(undefined);
		if (r.routed) throw new Error("expected the unroutable arm");
		expect(unroutableResult(4113, r).type).toBe("");
	});
});

// The property the guard exists to enforce, asserted at the routing seam: a mis-typed or
// unclassifiable issue dispatches NO agent at all, and a decision dispatches the adr agent
// instead of a coder. Mirrors the workflow's Classify branch over the pure decision with a fake
// dispatcher that records every dispatch (the `post-build.unit.test.ts` sibling shape).
describe("Classify-stage routing — the dispatch a type produces (issue #4113)", () => {
	const driveClassify = (issue: number, rawType: unknown, dispatched: string[]) => {
		const route = routeIssueType(rawType);
		if (!route.routed) return unroutableResult(issue, route);
		dispatched.push(route.lane);
		return {dispatched: route.lane, issue};
	};

	it("dispatches the adr agent — not a coder — for a type:decision issue", () => {
		const dispatched: string[] = [];
		driveClassify(4045, "type:decision", dispatched);
		expect(dispatched).toEqual(["adr"]);
		expect(dispatched).not.toContain("coder");
	});

	it("re-dispatching #4000 (type:decision) routes to the ADR seam, not a coder lane", () => {
		const dispatched: string[] = [];
		const out = driveClassify(4000, "type:decision", dispatched);
		expect(out).toMatchObject({dispatched: "adr", issue: 4000});
		expect(dispatched).toEqual(["adr"]);
	});

	it("dispatches NO agent at all when the type is unroutable — never a silent coder", () => {
		for (const raw of [undefined, "", "type:spike", "status:triaged", 3]) {
			const dispatched: string[] = [];
			const out = driveClassify(4113, raw, dispatched);
			expect(dispatched).toEqual([]);
			expect(out).toMatchObject({unroutable: true, issue: 4113});
		}
	});

	it("leaves the implement and plan lanes reaching their existing agents", () => {
		const dispatched: string[] = [];
		driveClassify(1, "type:epic", dispatched);
		driveClassify(2, "type:bug", dispatched);
		driveClassify(3, "type:feature", dispatched);
		driveClassify(4, "type:chore", dispatched);
		driveClassify(5, "type:investigation", dispatched);
		expect(dispatched).toEqual(["planner", "coder", "coder", "coder", "coder"]);
	});
});
