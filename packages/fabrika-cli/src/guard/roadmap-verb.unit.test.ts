/**
 * `guard roadmap-guard check` over a scripted filesystem and a scripted `gh` — the exit taxonomy the
 * port exists for. The v1 original exited `1` for drift, for an unreadable ROADMAP.md and
 * for a `gh` that could not answer; each case below pins one of those onto its own code.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, type FakeFsOptions, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {runRoadmapGuard} from "./roadmap-verb.ts";

const ROOT = "/repo";
const ROADMAP = `${ROOT}/ROADMAP.md`;
const MILESTONES = /^gh api --paginate repos\/o\/r\/milestones\?state=all/;

const ENV = {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>;

/** The projection `gh api --jq` prints: `<number>\t<state>\t<title>` rows. */
const milestones = (
	...rows: ReadonlyArray<readonly [number, "open" | "closed", string]>
): ExecResult => okOut(rows.map(([n, state, title]) => `${n}\t${state}\t${title}`).join("\n"));

const roadmap = (body: string): FakeFsOptions => ({files: {[ROADMAP]: body}});

const IN_SYNC = `# Roadmap

## Arcs

| Arc | Milestone | State |
|-----|-----------|-------|
| Four Pillars | #17 | active |
| Geçit | #24 | queued |

## Campaigns

| Campaign | Milestone | State |
|----------|-----------|-------|
| Mentor Audit | #27 | active |
`;

const PROJECTION = milestones(
	[17, "open", "Four Pillars"],
	[24, "open", "Geçit"],
	[27, "open", "Mentor Audit campaign"],
);

const run = (
	fs: FakeFsOptions,
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	env: Record<string, string | undefined> = ENV,
) =>
	Effect.runPromise(
		Effect.provide(
			runRoadmapGuard({root: ROOT, repo: null, cwd: ROOT, env}),
			Layer.merge(fakeFs(fs).layer, fakeShell(script).layer),
		),
	);

describe("runRoadmapGuard", () => {
	it("passes, naming the scanned rows and the projection it validated them against", async () => {
		const out = await run(roadmap(IN_SYNC), [[MILESTONES, PROJECTION]]);
		expect(out.code).toBe(0);
		expect(out.stdout.trim()).toBe(
			"guard roadmap-guard check: in sync — 2 arc row(s) + 1 campaign row(s) validated against 3 milestone(s), 1 campaign(s) active (I1–I5 all green).",
		);
		expect(out.stderr).toEqual([]);
	});

	it("reads the projection in ALL states, so a done row's closed pin still resolves", async () => {
		const out = await run(
			roadmap(`## Arcs

| Arc | Milestone | State |
|-----|-----------|-------|
| Now | #17 | active |
| Shipped | #10 | done |
`),
			[[MILESTONES, milestones([17, "open", "Now"], [10, "closed", "Shipped"])]],
		);
		expect(out.code).toBe(0);
	});

	it("seats drift on VIOLATION, naming every offending invariant", async () => {
		const out = await run(
			roadmap(`## Arcs

| Arc | Milestone | State |
|-----|-----------|-------|
| Now | #17 | active |
| Also now | #24 | active |
`),
			[[MILESTONES, milestones([17, "open", "Now"], [24, "open", "Also"], [42, "open", "Orphan"])]],
		);
		expect(out.code).toBe(VIOLATION);
		expect(out.stdout).toBe("");
		const report = out.stderr.join("\n");
		expect(report).toContain("[I2] expected exactly ONE active arc, found 2");
		expect(report).toContain('[I3] open milestone #42 ("Orphan")');
	});

	it("annotates each finding on ROADMAP.md under Actions", async () => {
		const out = await run(
			roadmap(`## Arcs

| Arc | Milestone | State |
|-----|-----------|-------|
| Zombie | #17 | active |
`),
			[[MILESTONES, milestones([17, "closed", "Retired"])]],
			{...ENV, GITHUB_ACTIONS: "true"},
		);
		expect(out.code).toBe(VIOLATION);
		expect(
			out.stderr.filter((line) => line.startsWith("::error file=ROADMAP.md::[I5] ")),
		).toHaveLength(1);
	});

	it("emits no annotation off a runner", async () => {
		const out = await run(roadmap("## Arcs\n\n| Arc | M | S |\n|-|-|-|\n| A | #9 | active |\n"), [
			[MILESTONES, milestones([17, "open", "Other"])],
		]);
		expect(out.code).toBe(VIOLATION);
		expect(out.stderr.some((line) => line.startsWith("::"))).toBe(false);
	});

	// ADR 0092's floor, on both sides of the check.
	it("fails closed on a ROADMAP.md with no arc rows", async () => {
		const out = await run(roadmap("# Roadmap\n\nNo tables yet.\n"), [[MILESTONES, PROJECTION]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("fail-closed (ADR 0092, I4)");
	});

	it("fails closed when the repo has no milestones at all", async () => {
		const out = await run(roadmap(IN_SYNC), [[MILESTONES, okOut("")]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.join("\n")).toContain("0 milestone(s)");
	});

	it("seats an ABSENT ROADMAP.md on PRECONDITION_UNKNOWN, never on a clean or a violation", async () => {
		const out = await run({files: {}}, [[MILESTONES, PROJECTION]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("UNKNOWN, never clean");
	});

	it("seats an UNREADABLE ROADMAP.md on PRECONDITION_UNKNOWN too", async () => {
		const out = await run({files: {[ROADMAP]: IN_SYNC}, unreadable: [ROADMAP]}, [
			[MILESTONES, PROJECTION],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toContain(ROADMAP);
	});

	it("seats a failed milestone read on PRECONDITION_UNKNOWN, never on ZERO_SCOPE", async () => {
		const out = await run(roadmap(IN_SYNC), [[MILESTONES, errOut("gh: Bad gateway (HTTP 502)")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toContain("Bad gateway");
	});

	// A shape that is not the projection asked for is a failed read, never an empty one — an empty
	// one would read as ZERO_SCOPE and blame the roadmap for `gh` printing something else.
	it("seats a malformed projection on PRECONDITION_UNKNOWN", async () => {
		const out = await run(roadmap(IN_SYNC), [[MILESTONES, okOut("17\tajar\tFour Pillars")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toContain('state is "ajar"');
	});

	it("refuses UNKNOWN when no repo resolves, rather than guessing one", async () => {
		const out = await run(roadmap(IN_SYNC), [[MILESTONES, PROJECTION]], {});
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("cannot resolve a target repo");
	});

	// The guard and the scope fence must validate one file (#6296). A guard pinned to `ROADMAP.md`
	// while `build pick` reads the declared one is a key with two answers.
	it("validates the file `roadmapFile` names, not its own literal", async () => {
		const out = await run(
			{
				files: {
					[`${ROOT}/.fabrika.jsonc`]: JSON.stringify({roadmapFile: "docs/PLAN.md"}),
					[`${ROOT}/docs/PLAN.md`]: IN_SYNC,
				},
			},
			[[MILESTONES, PROJECTION]],
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("roadmap-guard");
	});

	it("refuses UNKNOWN on a config it cannot decode, rather than falling back to ROADMAP.md", async () => {
		const out = await run(
			{
				files: {
					[`${ROOT}/.fabrika.jsonc`]: JSON.stringify({roadmapFile: 7}),
					[ROADMAP]: IN_SYNC,
				},
			},
			[[MILESTONES, PROJECTION]],
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toContain("which file this guard validates is unread");
	});

	it("refuses UNKNOWN when no repo root is found at or above the cwd", async () => {
		const out = await Effect.runPromise(
			Effect.provide(
				runRoadmapGuard({root: null, repo: null, cwd: "/nowhere", env: ENV}),
				Layer.merge(fakeFs({files: {}}).layer, fakeShell([[MILESTONES, PROJECTION]]).layer),
			),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toContain("no repo root at or above /nowhere");
	});
});
