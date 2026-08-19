import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import {ANSWER, FAILED} from "../verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {RUNNING_MARKER, runHomes, STANDING_LANES} from "./homes-verb.ts";

const MILESTONES = /repos\/o\/r\/milestones/;

const ROADMAP = `## Arcs

| Arc | Milestone | State |
|-----|-----------|-------|
| Geçit | #24 | active |

## Campaigns

| Campaign | Milestone | State |
|----------|-----------|-------|
| fabrika campaign | #44 | paused |
`;

const options = {
	roadmap: "ROADMAP.md",
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ReturnType<typeof okOut>]>,
	files: Record<string, string | null> = {"ROADMAP.md": ROADMAP},
	overrides: Partial<typeof options> = {},
	fs: {
		readonly unreadable?: ReadonlyArray<string>;
		readonly unprobeable?: ReadonlyArray<string>;
	} = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runHomes({...options, ...overrides}),
			Layer.merge(fakeShell(script).layer, fakeFs({files, ...fs}).layer),
		),
	);

const twoMilestones = [
	MILESTONES,
	okOut("24\tSözlük — search and discovery\n44\tfabrika"),
] as const;

describe("runHomes", () => {
	it("prints `homes` then the open milestones and the standing lanes", async () => {
		const out = await run([twoMilestones]);
		expect(out.code).toBe(ANSWER);
		expect(out.stdout.trimEnd().split("\n")).toEqual([
			"homes",
			"milestone\t24\tSözlük — search and discovery",
			"milestone\t44\tfabrika",
			"lane\twayfinder:backlog\tfog — uncharted work upstream of any arc",
			"lane\taxis:pipeline-hardening\tthe standing pipeline and reliability lane",
		]);
	});

	it("joins a milestone to its roadmap row by NUMBER — the two titles share no substring", async () => {
		const out = await run([twoMilestones], {"ROADMAP.md": ROADMAP}, {json: true});
		const payload = JSON.parse(out.stdout);
		expect(payload.milestones).toEqual([
			{number: 24, title: "Sözlük — search and discovery", roadmapRow: "Geçit"},
			{number: 44, title: "fabrika", roadmapRow: "fabrika campaign"},
		]);
	});

	it("reports an open milestone no roadmap row pins as null rather than hiding it", async () => {
		const out = await run(
			[[MILESTONES, okOut("99\toff-roadmap")]],
			{"ROADMAP.md": ROADMAP},
			{
				json: true,
			},
		);
		expect(JSON.parse(out.stdout).milestones).toEqual([
			{number: 99, title: "off-roadmap", roadmapRow: null},
		]);
	});

	it("carries the standing lanes into the --json payload from the one enumeration", async () => {
		const out = await run([twoMilestones], {"ROADMAP.md": ROADMAP}, {json: true});
		expect(JSON.parse(out.stdout).lanes).toEqual(STANDING_LANES);
	});

	it("reports the scanned milestone count on stderr", async () => {
		const out = await run([twoMilestones]);
		expect(out.stderr.join("\n")).toContain("scanned 2 open milestones in o/r");
	});

	it("REFUSES zero open milestones — `no home exists` routes to an irreversible close", async () => {
		const out = await run([[MILESTONES, okOut("")]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("0 open milestones");
	});

	it("still names the standing lanes on stderr when it refuses over zero milestones", async () => {
		const out = await run([[MILESTONES, okOut("")]]);
		expect(out.stderr.join("\n")).toContain("wayfinder:backlog");
		expect(out.stderr.join("\n")).toContain("axis:pipeline-hardening");
	});

	it("refuses an unreadable milestone list as UNKNOWN — never as `no homes`", async () => {
		const out = await run([[MILESTONES, errOut("gh: Bad gateway (HTTP 502)")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("never empty");
	});

	it("refuses a roadmap that EXISTS but cannot be read as UNKNOWN rather than answering unjoined", async () => {
		const out = await run(
			[twoMilestones],
			{"ROADMAP.md": ROADMAP},
			{},
			{unreadable: ["ROADMAP.md"]},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("cannot read the roadmap");
	});

	it("refuses a roadmap whose EXISTENCE could not be probed as UNKNOWN", async () => {
		const out = await run([twoMilestones], {}, {}, {unprobeable: ["ROADMAP.md"]});
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("cannot probe the roadmap");
	});

	it("ANSWERS over an absent roadmap — every milestone lists, unjoined, beside the standing lanes", async () => {
		const out = await run([twoMilestones], {});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout.trimEnd().split("\n")).toEqual([
			"homes",
			"milestone\t24\tSözlük — search and discovery",
			"milestone\t44\tfabrika",
			"lane\twayfinder:backlog\tfog — uncharted work upstream of any arc",
			"lane\taxis:pipeline-hardening\tthe standing pipeline and reliability lane",
		]);
	});

	it("says on stderr that no roadmap was found, so the empty join is visible rather than silent", async () => {
		const out = await run([twoMilestones], {});
		expect(out.stderr.join("\n")).toContain("no roadmap at ROADMAP.md");
	});

	it("names the flagged path in that notice, not a compiled-in default", async () => {
		const out = await run([twoMilestones], {}, {roadmap: "docs/ROADMAP.md"});
		expect(out.stderr.join("\n")).toContain("no roadmap at docs/ROADMAP.md");
	});

	it("carries the milestones with a null roadmapRow into valid --json on the absent path", async () => {
		const out = await run([twoMilestones], {}, {json: true});
		expect(out.code).toBe(ANSWER);
		expect(JSON.parse(out.stdout).milestones).toEqual([
			{number: 24, title: "Sözlük — search and discovery", roadmapRow: null},
			{number: 44, title: "fabrika", roadmapRow: null},
		]);
	});

	it("still refuses zero open milestones when the roadmap is absent — the two guards are independent", async () => {
		const out = await run([[MILESTONES, okOut("")]], {});
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.join("\n")).toContain("0 open milestones");
	});

	it("REFUSES a roadmap that parsed to 0 arc rows — a grammar change empties the join silently", async () => {
		const out = await run([twoMilestones], {"ROADMAP.md": "# Roadmap\n\nNo tables.\n"});
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("0 arc rows");
	});

	it("passes a roadmap with arcs but ZERO campaigns — that is a legitimate state", async () => {
		const arcsOnly = "## Arcs\n\n| Arc | Milestone |\n|---|---|\n| Geçit | #24 |\n";
		const out = await run([twoMilestones], {"ROADMAP.md": arcsOnly});
		expect(out.code).toBe(ANSWER);
	});

	it("pages the milestone read and asks only for open ones", async () => {
		const shell = fakeShell([twoMilestones]);
		await Effect.runPromise(
			Effect.provide(
				runHomes(options),
				Layer.merge(shell.layer, fakeFs({files: {"ROADMAP.md": ROADMAP}}).layer),
			),
		);
		expect(shell.calls[0]).toContain("--paginate");
		expect(shell.calls[0]).toContain("state=open");
	});

	it("reads the roadmap the --roadmap flag names", async () => {
		const out = await run(
			[twoMilestones],
			{"docs/ROADMAP.md": ROADMAP},
			{
				roadmap: "docs/ROADMAP.md",
			},
		);
		expect(out.code).toBe(ANSWER);
	});

	it("refuses when no target repo resolves", async () => {
		const out = await run(
			[[/git remote get-url/, errOut("no origin")]],
			{"ROADMAP.md": ROADMAP},
			{
				env: {},
			},
		);
		expect(out.code).toBe(FAILED);
		expect(out.stderr.at(-1)).toContain("CLAUDE_PIPELINE_REPO");
	});
});

describe("runHomes and the running-campaign marker", () => {
	const withActive = (milestone: string) =>
		ROADMAP.replace("| #44 | paused |", `| ${milestone} | active |`);

	it("marks the active campaign's milestone row and leaves every other row exactly as today", async () => {
		const out = await run([twoMilestones], {"ROADMAP.md": withActive("#44")});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout.trimEnd().split("\n")).toEqual([
			"homes",
			"milestone\t24\tSözlük — search and discovery",
			`milestone\t44\tfabrika\t${RUNNING_MARKER}`,
			"lane\twayfinder:backlog\tfog — uncharted work upstream of any arc",
			"lane\taxis:pipeline-hardening\tthe standing pipeline and reliability lane",
		]);
	});

	it("carries the same fact as a per-milestone --json field, absent on an unmarked row", async () => {
		const out = await run([twoMilestones], {"ROADMAP.md": withActive("#44")}, {json: true});
		expect(JSON.parse(out.stdout).milestones).toEqual([
			{number: 24, title: "Sözlük — search and discovery", roadmapRow: "Geçit"},
			{number: 44, title: "fabrika", roadmapRow: "fabrika campaign", running: RUNNING_MARKER},
		]);
	});

	it("still LISTS the active campaign's milestone — the marker annotates a row, it never removes one", async () => {
		const out = await run([twoMilestones], {"ROADMAP.md": withActive("#44")});
		expect(out.stdout).toContain("milestone\t44\tfabrika");
	});

	it("marks no row when no campaign is active, and answers exactly as it does today", async () => {
		const text = await run([twoMilestones], {"ROADMAP.md": ROADMAP});
		const machine = await run([twoMilestones], {"ROADMAP.md": ROADMAP}, {json: true});
		expect(text.stdout).not.toContain("running");
		expect(machine.stdout).not.toContain("running");
		expect(text.stderr.join("\n")).toContain("campaigns: none active");
	});

	it("never reads a MALFORMED campaigns table as `no milestone is running` — it says so and marks no row", async () => {
		const out = await run([twoMilestones], {
			"ROADMAP.md": ROADMAP.replace("| #44 | paused |", "| forty-four | active |"),
		});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).not.toContain("running");
		expect(out.stderr.join("\n")).toContain("campaigns: unreadable");
	});

	it("leaves every row unmarked, and does not fail, when the active campaign names a milestone not open", async () => {
		const out = await run([twoMilestones], {"ROADMAP.md": withActive("#999")});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).not.toContain("running");
		expect(out.stderr.join("\n")).toContain("fabrika campaign (#999)");
	});
});

describe("STANDING_LANES", () => {
	it("is the only enumeration of the lanes — two of them, and no third", () => {
		expect(STANDING_LANES.map((l) => l.label)).toEqual([
			"wayfinder:backlog",
			"axis:pipeline-hardening",
		]);
	});
});
