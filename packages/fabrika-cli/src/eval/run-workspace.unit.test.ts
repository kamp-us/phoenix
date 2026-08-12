/**
 * What lands in a graded candidate's working directory, and that it is that run's alone (#5434, #5437).
 *
 * The two defects were one cause, so they are pinned by one test. A check that only asserts "no
 * `evals.json` in the directory" passes on a build where all five runs still share one, and a check
 * that only counts directories passes on a build that stages the answer key into each — so both
 * properties are asserted over the same five staged runs, driven through the real `runGradedAxis` so
 * the per-run threading `command.ts` depends on is exercised rather than assumed.
 *
 * The staging tier runs against the real Node filesystem on purpose: "the answer key is not there" is
 * a property of the directory, and a scripted `FileSystem` double would assert the calls that were
 * made instead of what a candidate could open.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect, FileSystem, Path} from "effect";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {type GradableCase, type RunVerdict, runGradedAxis} from "./graded-axis.ts";
import {EVAL_SET_FILE, runDirName, stageRunWorkspace, stagingPlan} from "./run-workspace.ts";

const live = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>): Promise<A> =>
	Effect.runPromise(Effect.provide(effect, NodeServices.layer));

const FIXTURE = "evals/cases/eval-1.md";
const FIXTURE_BODY = "the case's own fixture material";

const gradableCase: GradableCase = {
	id: 1,
	prompt: "Read evals/cases/eval-1.md and do what it asks.",
	expectedOutput: "The pattern clears the bar; terminal PATTERN-RECORDED.",
	expectations: ["the terminal is PATTERN-RECORDED"],
	files: [FIXTURE],
};

/** A skill root shaped like a real one: the authored set beside the case material it points at. */
const makeSkillRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "fabrika-skill-"));
	mkdirSync(join(root, "evals", "cases"), {recursive: true});
	writeFileSync(
		join(root, "evals", EVAL_SET_FILE),
		JSON.stringify({
			skill_name: "write-pattern",
			evals: [{id: 1, expected_output: "the answer key nobody under test may read"}],
		}),
	);
	writeFileSync(join(root, "evals", "cases", "eval-1.md"), FIXTURE_BODY);
	writeFileSync(join(root, "evals", "cases", "eval-2.md"), "another case's fixture material");
	return root;
};

/** Every path under `dir`, relative and slash-normalised — what a candidate could reach. */
const treeOf = (dir: string): ReadonlyArray<string> =>
	readdirSync(dir, {recursive: true, encoding: "utf8"})
		.map((entry) => entry.replaceAll("\\", "/"))
		.sort();

const bytesUnder = (dir: string): string =>
	treeOf(dir)
		.map((entry) => join(dir, entry))
		.filter((full) => statSync(full).isFile())
		.map((full) => readFileSync(full, "utf8"))
		.join("\n");

describe("which declared fixtures may be staged", () => {
	it("refuses the authored eval set by name — the answer key is never a fixture", () => {
		const plan = stagingPlan([FIXTURE, `evals/${EVAL_SET_FILE}`]);
		expect(plan.staged).toEqual([FIXTURE]);
		expect(plan.refused.map((refusal) => refusal.path)).toEqual([`evals/${EVAL_SET_FILE}`]);
	});

	it("refuses paths that would reach outside the run directory", () => {
		const plan = stagingPlan(["/etc/passwd", "../evals/cases/eval-2.md", "  ", "C:\\keys.json"]);
		expect(plan.staged).toEqual([]);
		expect(plan.refused).toHaveLength(4);
	});

	it("stages a repeated entry once", () => {
		expect(stagingPlan([FIXTURE, FIXTURE]).staged).toEqual([FIXTURE]);
	});
});

describe("a run's directory name", () => {
	it("carries the case, the 1-based run and the session id the same spawn is pinned to", () => {
		expect(runDirName({caseId: 3, run: 4, sessionId: "9f1c0d2b"})).toBe("case3-run4-9f1c0d2b");
	});
});

describe("the five graded runs of one case", () => {
	let skillRoot = "";

	beforeEach(() => {
		skillRoot = makeSkillRoot();
	});
	afterEach(() => {
		rmSync(skillRoot, {recursive: true, force: true});
	});

	/**
	 * Drive the real axis with a stub that stages, snapshots what it was handed, and only then writes
	 * a deliverable — the shape a candidate leaves behind, and what the next run must not be able to see.
	 */
	const stageFiveRuns = () =>
		live(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const observed: Array<{
					readonly run: number;
					readonly dir: string;
					readonly staged: ReadonlyArray<string>;
					readonly bytes: string;
				}> = [];
				yield* runGradedAxis({
					cases: [gradableCase],
					runOnce: ({evalCase, run}) =>
						Effect.scoped(
							Effect.gen(function* () {
								const workspace = yield* stageRunWorkspace({
									skillRoot,
									caseId: evalCase.id,
									run,
									sessionId: `session-${run}`,
									files: evalCase.files,
								});
								if (workspace._tag !== "Staged") {
									return {_tag: "NoVerdict", reason: "invocation-failed"} satisfies RunVerdict;
								}
								observed.push({
									run,
									dir: workspace.dir,
									staged: treeOf(workspace.dir),
									bytes: bytesUnder(workspace.dir),
								});
								yield* Effect.orDie(
									fs.writeFileString(
										path.join(workspace.dir, "VERDICT-DRAFT.md"),
										`run ${run} says PASS`,
									),
								);
								return {_tag: "Verdict", passed: true} satisfies RunVerdict;
							}),
						),
				});
				return observed;
			}),
		);

	it("each execute in their own fresh directory, with no sibling run's deliverables in it", async () => {
		const observed = await stageFiveRuns();

		expect(observed).toHaveLength(5);
		expect(new Set(observed.map((run) => run.dir)).size).toBe(5);
		for (const run of observed) {
			expect(run.dir.endsWith(`case1-run${run.run}-session-${run.run}`)).toBe(true);
			expect(run.staged).not.toContain("VERDICT-DRAFT.md");
			expect(run.bytes).not.toContain("says PASS");
		}
	});

	it("hold the case's own fixture at the path its authored prompt reads, and nothing else", async () => {
		const observed = await stageFiveRuns();

		for (const run of observed) {
			expect(run.staged).toEqual(["evals", "evals/cases", FIXTURE]);
			expect(run.bytes).toBe(FIXTURE_BODY);
			expect(run.bytes).not.toContain("expected_output");
			expect(run.bytes).not.toContain("answer key");
		}
	});

	it("are removed when the run's scope closes, so isolation leaves nothing behind", async () => {
		const observed = await stageFiveRuns();

		for (const run of observed) expect(existsSync(run.dir)).toBe(false);
	});
});
