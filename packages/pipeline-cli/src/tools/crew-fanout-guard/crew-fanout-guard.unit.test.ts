/**
 * Pure-core tests for `crew-fanout-guard` (#3606): the frontmatter parse, the
 * every-agent-type-is-classified decision, the future-agent fail-closed hole, and the
 * zero-scope / missing-bridge / stale-classification fail-closed verdicts (ADR 0092). No IO —
 * the filesystem seam is crossed in `gate.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	type AgentDef,
	BRIDGE_ALLOWLIST,
	BRIDGE_OUT_OF_SCOPE,
	type CrewFanoutInput,
	judge,
	parseAgentDef,
	parseFrontmatter,
	renderReport,
} from "./crew-fanout-guard.ts";

// The full mutating roster the current crew ships (kampus-pipeline agents + the crew engine),
// plus the read-only investigator and the three bridges. This mirrors the live agent defs.
const PIPELINE_AGENTS = [
	"coder",
	"reviewer",
	"shipper",
	"planner",
	"canon",
	"adr",
	"triager",
	"reporter",
];
const CREW_AGENTS = [
	"crew-cartographer",
	"crew-chief-of-staff",
	"crew-engineering-manager",
	"crew-intake-desk",
	"crew-investigator",
];
const FULL_ROSTER = [...PIPELINE_AGENTS, ...CREW_AGENTS];

const bridge = (name: string): AgentDef => ({name});

// A bridge def contributes only its identity now — the spawn classification lives in the
// guard's own two tables, not in the def (see the module docblock / #3764).
const CARTOGRAPHER = bridge("crew-cartographer");
const CHIEF = bridge("crew-chief-of-staff");
const INTAKE = bridge("crew-intake-desk");

const currentInput = (): CrewFanoutInput => ({
	rosterAgents: FULL_ROSTER,
	bridges: [CARTOGRAPHER, CHIEF, INTAKE],
});

describe("parseFrontmatter / parseAgentDef", () => {
	it("extracts the name from a real bridge def's frontmatter", () => {
		const md = [
			"---",
			"name: crew-cartographer",
			"model: inherit",
			'tools: ["Read", "Task"]',
			"---",
			"",
			"body text",
		].join("\n");
		expect(parseAgentDef(md)).toEqual({name: "crew-cartographer"});
	});

	it("returns null for a def with no frontmatter or no name", () => {
		expect(parseAgentDef("no frontmatter here")).toBeNull();
		expect(parseAgentDef("---\nmodel: inherit\n---\nbody")).toBeNull();
	});

	it("parseFrontmatter tolerates CRLF fences", () => {
		expect(parseFrontmatter("---\r\nname: x\r\n---\r\nbody")).toEqual({name: "x"});
	});
});

describe("judge — the every-agent-type-is-classified decision", () => {
	it("PASSES on the current, fully-scoped crew roster", () => {
		const v = judge(currentInput());
		expect(v.pass).toBe(true);
		if (v.pass) {
			// the read-only investigator is excluded from the mutating roster
			expect(v.mutatingRoster).not.toContain("crew-investigator");
			expect(v.mutatingRoster).toContain("coder");
			expect(v.bridges).toEqual(["crew-cartographer", "crew-chief-of-staff", "crew-intake-desk"]);
		}
	});

	it("FAILS CLOSED on a FUTURE mutating agent-type no bridge classifies (the #3606 hole)", () => {
		const input: CrewFanoutInput = {
			rosterAgents: [...FULL_ROSTER, "crew-auditor"],
			bridges: [CARTOGRAPHER, CHIEF, INTAKE],
		};
		const v = judge(input);
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "uncovered") {
			// no bridge allowlists or scopes out the new type
			expect(v.gaps.map((g) => g.bridge).sort()).toEqual([
				"crew-cartographer",
				"crew-chief-of-staff",
				"crew-intake-desk",
			]);
			expect(v.gaps.every((g) => g.agent === "crew-auditor")).toBe(true);
		} else {
			throw new Error(`expected an uncovered verdict, got ${v.pass ? "pass" : v.reason}`);
		}
	});

	it("keeps the two classification tables disjoint and jointly total over the mutating roster", () => {
		// The pass above is the coverage proof; this pins the shape that makes it non-vacuous —
		// an agent-type on BOTH tables would let a table edit go unnoticed.
		for (const name of ["crew-cartographer", "crew-chief-of-staff", "crew-intake-desk"] as const) {
			const allow = new Set(BRIDGE_ALLOWLIST[name]);
			expect(BRIDGE_OUT_OF_SCOPE[name].filter((a) => allow.has(a))).toEqual([]);
		}
		expect(BRIDGE_ALLOWLIST["crew-intake-desk"]).toContain("planner");
		expect(BRIDGE_OUT_OF_SCOPE["crew-intake-desk"]).toContain("coder");
	});

	it("classifies the chief-of-staff's reporter fanout as allowed, not out of scope (#3888)", () => {
		// The CoS delegates capture to `reporter` (write-scoped to issue creation), so it must be on
		// the allowlist and OFF the out-of-scope table — the highest-observation seat's context-hygiene
		// fanout, not an execution edge (ADR 0196). The bridge/engine line (ADR 0189) stays intact.
		expect(BRIDGE_ALLOWLIST["crew-chief-of-staff"]).toContain("reporter");
		expect(BRIDGE_OUT_OF_SCOPE["crew-chief-of-staff"]).not.toContain("reporter");
		// the execution engines stay explicitly out of scope — no pipeline path opens
		for (const engine of ["coder", "reviewer", "shipper", "planner", "canon", "adr", "triager"]) {
			expect(BRIDGE_OUT_OF_SCOPE["crew-chief-of-staff"]).toContain(engine);
		}
		// classification stays total: the roster still passes with reporter now allowlisted for the CoS
		expect(judge(currentInput()).pass).toBe(true);
	});

	it("fails closed on zero roster and on zero bridges (ADR 0092)", () => {
		expect(judge({rosterAgents: [], bridges: [CARTOGRAPHER, CHIEF, INTAKE]})).toMatchObject({
			pass: false,
			reason: "zero-scope",
		});
		expect(judge({rosterAgents: FULL_ROSTER, bridges: []})).toMatchObject({
			pass: false,
			reason: "zero-scope",
		});
	});

	it("fails closed when an expected bridge def is absent", () => {
		const v = judge({rosterAgents: FULL_ROSTER, bridges: [CARTOGRAPHER, INTAKE]});
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "missing-bridge") {
			expect(v.missing).toEqual(["crew-chief-of-staff"]);
		} else {
			throw new Error("expected a missing-bridge verdict");
		}
	});

	it("fails closed on a stale classification entry (names an agent not in the roster)", () => {
		// drop `reporter` from the roster while an allowlist still names it.
		const roster = FULL_ROSTER.filter((a) => a !== "reporter");
		const v = judge({rosterAgents: roster, bridges: [CARTOGRAPHER, CHIEF, INTAKE]});
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "stale-allowlist") {
			expect(v.entries.map((e) => e.agent)).toContain("reporter");
		} else {
			throw new Error("expected a stale-allowlist verdict");
		}
	});
});

describe("renderReport", () => {
	it("names the scanned bridges + mutating roster on a pass", () => {
		const report = renderReport(judge(currentInput()));
		expect(report).toContain("crew-cartographer");
		expect(report).toContain("mutating roster");
	});

	it("names the offending bridge×agent pair on an unclassified fail", () => {
		const v = judge({
			rosterAgents: [...FULL_ROSTER, "crew-auditor"],
			bridges: [CARTOGRAPHER, CHIEF, INTAKE],
		});
		const report = renderReport(v);
		expect(report).toContain("crew-auditor");
		expect(report).toContain("neither allowlists nor scopes out");
	});
});
