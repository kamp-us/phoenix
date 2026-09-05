import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import {ANSWER, FAILED} from "../verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {RUNNING_MARKER, runHomes} from "./homes-verb.ts";
import {offeredLanes} from "./standing-lanes.ts";

const MILESTONES = /GET .*\/repos\/o\/r\/milestones\?/;
const LABELS = /GET .*\/repos\/o\/r\/labels\?/;

const UNREADABLE: HttpReply = {status: 502, body: "{}"};

const labels = (...names: ReadonlyArray<string>): HttpReply => ({
	status: 200,
	body: JSON.stringify(names.map((name) => ({name}))),
});

const milestones = (
	...rows: ReadonlyArray<{readonly number: number; readonly title: string}>
): HttpReply => ({status: 200, body: JSON.stringify(rows)});

/** The shipped default lane set — what a repo declaring no `boardVocabulary` resolves to. */
const PHOENIX_LANES = ["wayfinder:backlog", "axis:pipeline-hardening"];

/** A board carrying both lane labels, so the presence filter offers both — phoenix's own state. */
const bothLabels = [LABELS, labels("type:bug", ...PHOENIX_LANES)] as const;

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
	standingLanes: PHOENIX_LANES as ReadonlyArray<string>,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (
	script: ReadonlyArray<Scripted>,
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
			// The label read is appended, never prepended: a case that scripts `LABELS` itself is
			// asserting on the presence filter, and its entry has to win the first-match lookup.
			Layer.merge(fakeSeams([...script, bothLabels]).layer, fakeFs({files, ...fs}).layer),
		),
	);

const twoMilestones = [
	MILESTONES,
	milestones({number: 24, title: "Sözlük — search and discovery"}, {number: 44, title: "fabrika"}),
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
			[[MILESTONES, milestones({number: 99, title: "off-roadmap"})]],
			{"ROADMAP.md": ROADMAP},
			{
				json: true,
			},
		);
		expect(JSON.parse(out.stdout).milestones).toEqual([
			{number: 99, title: "off-roadmap", roadmapRow: null},
		]);
	});

	it("reports the scanned milestone count on stderr", async () => {
		const out = await run([twoMilestones]);
		expect(out.stderr.join("\n")).toContain("scanned 2 open milestones in o/r");
	});

	it("REFUSES zero open milestones — `no home exists` routes to an irreversible close", async () => {
		const out = await run([[MILESTONES, milestones()]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("0 open milestones");
	});

	it("still names the standing lanes on stderr when it refuses over zero milestones", async () => {
		const out = await run([[MILESTONES, milestones()]]);
		expect(out.stderr.join("\n")).toContain("wayfinder:backlog");
		expect(out.stderr.join("\n")).toContain("axis:pipeline-hardening");
	});

	it("refuses an unreadable milestone list as UNKNOWN — never as `no homes`", async () => {
		const out = await run([[MILESTONES, UNREADABLE]]);
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
		const out = await run([[MILESTONES, milestones()]], {});
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
		const shell = fakeSeams([twoMilestones, bothLabels]);
		await Effect.runPromise(
			Effect.provide(
				runHomes(options),
				Layer.merge(shell.layer, fakeFs({files: {"ROADMAP.md": ROADMAP}}).layer),
			),
		);
		const call = shell.requests.find((line) => line.includes("/milestones")) ?? "";
		expect(call).toContain("per_page=100");
		expect(call).toContain("state=open");
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

	it("states the admitted bands verbatim — the channels below read this constant, so nothing else pins its text", () => {
		expect(RUNNING_MARKER).toBe("running: p0/p1 or blocker");
	});

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

describe("runHomes and the standing lanes the host repo carries", () => {
	it("offers a declared lane only when the board carries its label — the bare-repo arm", async () => {
		const out = await run([twoMilestones, [LABELS, labels("bug", "enhancement")]]);
		expect(out.code).toBe(ANSWER);
		expect(out.stdout.trimEnd().split("\n")).toEqual([
			"homes",
			"milestone\t24\tSözlük — search and discovery",
			"milestone\t44\tfabrika",
		]);
	});

	it("still offers both in a repo carrying both — the shipped default reproduces phoenix", async () => {
		const out = await run([twoMilestones]);
		expect(out.stdout.trimEnd().split("\n").slice(-2)).toEqual([
			"lane\twayfinder:backlog\tfog — uncharted work upstream of any arc",
			"lane\taxis:pipeline-hardening\tthe standing pipeline and reliability lane",
		]);
	});

	it("drops only the missing lane when the board carries one of the two", async () => {
		const out = await run([twoMilestones, [LABELS, labels("wayfinder:backlog")]]);
		expect(out.stdout).toContain("lane\twayfinder:backlog");
		expect(out.stdout).not.toContain("axis:pipeline-hardening");
	});

	it("names the dropped labels on stderr, so the config/board gap is readable at the point it bites", async () => {
		const out = await run([twoMilestones, [LABELS, labels("bug")]]);
		expect(out.stderr.join("\n")).toContain(
			"standing lanes: 0 of 2 declared carry a label in o/r — not offered: wayfinder:backlog, axis:pipeline-hardening.",
		);
	});

	it("carries the offered lanes, not the declared set, into the --json payload", async () => {
		const out = await run([twoMilestones, [LABELS, labels("wayfinder:backlog")]], {}, {json: true});
		expect(JSON.parse(out.stdout).lanes).toEqual(
			offeredLanes(PHOENIX_LANES, new Set(["wayfinder:backlog"])),
		);
	});

	it("refuses an unreadable label list as UNKNOWN — never as `this repo declares no lanes`", async () => {
		const out = await run([twoMilestones, [LABELS, UNREADABLE]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("which standing lanes this board accepts is UNKNOWN");
	});

	/*
	 * The empty declared set an operator produces with `"standingLanes": []` — the config half is
	 * `standing-lanes.unit.test.ts`'s "reads an explicitly empty declaration as zero lanes", and
	 * `command.ts` passes what it read straight through (#6440).
	 */
	it("reads no labels at all when the repo declares no lanes — there is nothing to filter", async () => {
		const shell = fakeSeams([twoMilestones]);
		await Effect.runPromise(
			Effect.provide(
				runHomes({...options, standingLanes: []}),
				Layer.merge(shell.layer, fakeFs({files: {"ROADMAP.md": ROADMAP}}).layer),
			),
		);
		expect(shell.requests.some((line) => line.includes("/labels"))).toBe(false);
	});

	it("says the repo declares none rather than printing a bare 0-of-0 count", async () => {
		const out = await run([twoMilestones], {"ROADMAP.md": ROADMAP}, {standingLanes: []});
		expect(out.code).toBe(ANSWER);
		expect(out.stdout).not.toContain("lane\t");
		expect(out.stderr.join("\n")).toContain("standing lanes: this repo declares none.");
	});
});
