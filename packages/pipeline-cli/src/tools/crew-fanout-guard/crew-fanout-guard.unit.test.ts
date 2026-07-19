/**
 * Pure-core tests for `crew-fanout-guard` (#3606): the frontmatter/disallowedTools parse,
 * the enforced-allowlist coverage decision, the future-agent fail-closed hole, and the
 * zero-scope / missing-bridge / stale-allowlist fail-closed verdicts (ADR 0092). No IO —
 * the filesystem seam is crossed in `gate.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	type AgentDef,
	BRIDGE_ALLOWLIST,
	type CrewFanoutInput,
	disallowedTaskTypes,
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

const bridge = (name: string, disallowedTaskTypes: ReadonlyArray<string>): AgentDef => ({
	name,
	disallowedTaskTypes,
});

// The three bridge defs, scoped to exactly cover their non-allowlisted mutating roster —
// i.e. the live #3605 disallowedTools, expressed as agent-type names.
const CARTOGRAPHER = bridge("crew-cartographer", [
	"reviewer",
	"shipper",
	"crew-engineering-manager",
	"crew-chief-of-staff",
	"crew-intake-desk",
	"crew-cartographer",
]);
const CHIEF = bridge("crew-chief-of-staff", [
	"coder",
	"reviewer",
	"shipper",
	"planner",
	"canon",
	"adr",
	"triager",
	"reporter",
	"crew-engineering-manager",
	"crew-cartographer",
	"crew-intake-desk",
	"crew-chief-of-staff",
]);
const INTAKE = bridge("crew-intake-desk", [
	"coder",
	"reviewer",
	"shipper",
	"crew-engineering-manager",
	"crew-cartographer",
	"crew-chief-of-staff",
	"crew-intake-desk",
]);

const currentInput = (): CrewFanoutInput => ({
	rosterAgents: FULL_ROSTER,
	bridges: [CARTOGRAPHER, CHIEF, INTAKE],
});

describe("parseFrontmatter / parseAgentDef", () => {
	it("extracts name + disallowedTools from a real bridge def's frontmatter", () => {
		const md = [
			"---",
			"name: crew-cartographer",
			"model: inherit",
			'tools: ["Read", "Task"]',
			'disallowedTools: ["Task(reviewer)", "Task(shipper)"]',
			"---",
			"",
			"body text",
		].join("\n");
		expect(parseAgentDef(md)).toEqual({
			name: "crew-cartographer",
			disallowedTaskTypes: ["reviewer", "shipper"],
		});
	});

	it("returns null for a def with no frontmatter or no name", () => {
		expect(parseAgentDef("no frontmatter here")).toBeNull();
		expect(parseAgentDef("---\nmodel: inherit\n---\nbody")).toBeNull();
	});

	it("parses a def with no disallowedTools as an empty deny list", () => {
		const md = '---\nname: crew-engineering-manager\ntools: ["Task"]\n---\nbody';
		expect(parseAgentDef(md)).toEqual({name: "crew-engineering-manager", disallowedTaskTypes: []});
	});

	it("parseFrontmatter tolerates CRLF fences", () => {
		expect(parseFrontmatter("---\r\nname: x\r\n---\r\nbody")).toEqual({name: "x"});
	});
});

describe("disallowedTaskTypes — extract agent-types from Task(...) denies only", () => {
	it("keeps Task(x) entries, drops non-Task and malformed tokens", () => {
		expect(
			disallowedTaskTypes(["Task(reviewer)", "Task( shipper )", "Bash", "Task()", "Edit"]),
		).toEqual(["reviewer", "shipper"]);
	});

	it("returns empty for a non-array", () => {
		expect(disallowedTaskTypes(undefined)).toEqual([]);
		expect(disallowedTaskTypes("Task(reviewer)")).toEqual([]);
	});
});

describe("judge — the enforced-allowlist coverage decision", () => {
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

	it("FAILS CLOSED on a FUTURE mutating agent-type no bridge allowlists or denies (the #3606 hole)", () => {
		const input: CrewFanoutInput = {
			rosterAgents: [...FULL_ROSTER, "crew-auditor"],
			bridges: [CARTOGRAPHER, CHIEF, INTAKE],
		};
		const v = judge(input);
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "uncovered") {
			// every bridge is missing a deny for the new type, and none allowlists it
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

	it("FAILS CLOSED when a bridge silently drops a Task(x) deny for a non-allowlisted type", () => {
		// reviewer is NOT on the cartographer allowlist; removing its deny must red.
		const weakened = bridge(
			"crew-cartographer",
			CARTOGRAPHER.disallowedTaskTypes.filter((t) => t !== "reviewer"),
		);
		const v = judge({rosterAgents: FULL_ROSTER, bridges: [weakened, CHIEF, INTAKE]});
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "uncovered") {
			expect(v.gaps).toContainEqual({bridge: "crew-cartographer", agent: "reviewer"});
		} else {
			throw new Error("expected an uncovered verdict");
		}
	});

	it("does NOT require a bridge to deny an agent-type on its own allowlist", () => {
		// intake-desk allowlists planner/canon/adr — dropping those denies stays green.
		const v = judge({rosterAgents: FULL_ROSTER, bridges: [CARTOGRAPHER, CHIEF, INTAKE]});
		expect(v.pass).toBe(true);
		expect(BRIDGE_ALLOWLIST["crew-intake-desk"]).toContain("planner");
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

	it("fails closed on a stale allowlist entry (allowlists an agent not in the roster)", () => {
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

	it("names the offending bridge×agent pair on an uncovered fail", () => {
		const v = judge({
			rosterAgents: [...FULL_ROSTER, "crew-auditor"],
			bridges: [CARTOGRAPHER, CHIEF, INTAKE],
		});
		const report = renderReport(v);
		expect(report).toContain("crew-auditor");
		expect(report).toContain("neither allowlists nor denies");
	});
});
