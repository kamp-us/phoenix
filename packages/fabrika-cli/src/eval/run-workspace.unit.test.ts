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
import {Console, Effect, FileSystem, Path} from "effect";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {type GradableCase, type RunVerdict, runGradedAxis} from "./graded-axis.ts";
import {
	EVAL_SET_FILE,
	ISOLATED_DIR_NOTE,
	runDirName,
	stageRunWorkspace,
	stagingPlan,
} from "./run-workspace.ts";

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

/**
 * A skill root shaped like a real one: the authored set beside the case material it points at.
 *
 * It carries the same file under **both** authored conventions — skill-root-relative
 * `evals/cases/eval-1.md` and set-directory-relative `fixtures/eval-1.md` — because the corpus uses
 * both and a run has to resolve either (#5434).
 */
const makeSkillRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "fabrika-skill-"));
	mkdirSync(join(root, "evals", "cases"), {recursive: true});
	mkdirSync(join(root, "evals", "fixtures"), {recursive: true});
	writeFileSync(
		join(root, "evals", EVAL_SET_FILE),
		JSON.stringify({
			skill_name: "write-pattern",
			evals: [{id: 1, expected_output: "the answer key nobody under test may read"}],
		}),
	);
	writeFileSync(join(root, "evals", "cases", "eval-1.md"), FIXTURE_BODY);
	writeFileSync(join(root, "evals", "cases", "eval-2.md"), "another case's fixture material");
	writeFileSync(join(root, "evals", "fixtures", "eval-1.md"), FIXTURE_BODY);
	return root;
};

const setPathOf = (skillRoot: string): string => join(skillRoot, "evals", EVAL_SET_FILE);

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
		// Withholding the answer key is the point, so it is the one refusal a run survives.
		expect(plan.refused.map((refusal) => refusal.blocking)).toEqual([false]);
	});

	it("refuses paths that would reach outside the run directory, and blocks the run", () => {
		const plan = stagingPlan(["/etc/passwd", "../evals/cases/eval-2.md", "  ", "C:\\keys.json"]);
		expect(plan.staged).toEqual([]);
		expect(plan.refused).toHaveLength(4);
		expect(plan.refused.every((refusal) => refusal.blocking)).toBe(true);
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
	const stageFiveRuns = (evalCase: GradableCase = gradableCase) => {
		// Captured rather than inspected on the real stderr: the announcement is the only thing a live
		// run leaves behind about the directories, so it is asserted here the way an operator reads it.
		const announced: Array<string> = [];
		const capturing: Console.Console = {
			...globalThis.console,
			error: (...args: ReadonlyArray<unknown>) => {
				announced.push(args.join(" "));
			},
		};
		return live(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const observed: Array<{
					readonly run: number;
					readonly dir: string;
					readonly staged: ReadonlyArray<string>;
					readonly bytes: string;
				}> = [];
				const results = yield* runGradedAxis({
					cases: [evalCase],
					runOnce: ({evalCase, run}) =>
						Effect.scoped(
							Effect.gen(function* () {
								const workspace = yield* stageRunWorkspace({
									setPath: setPathOf(skillRoot),
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
				return {observed, results, announced};
			}).pipe(Effect.provideService(Console.Console, capturing)),
		);
	};

	it("each execute in their own fresh directory, with no sibling run's deliverables in it", async () => {
		const {observed} = await stageFiveRuns();

		expect(observed).toHaveLength(5);
		expect(new Set(observed.map((run) => run.dir)).size).toBe(5);
		for (const run of observed) {
			expect(run.dir.endsWith(`case1-run${run.run}-session-${run.run}`)).toBe(true);
			expect(run.staged).not.toContain("VERDICT-DRAFT.md");
			expect(run.bytes).not.toContain("says PASS");
		}
	});

	it("hold the case's own fixture at the path its authored prompt reads, and nothing else", async () => {
		const {observed} = await stageFiveRuns();

		for (const run of observed) {
			expect(run.staged).toEqual(["evals", "evals/cases", FIXTURE]);
			expect(run.bytes).toBe(FIXTURE_BODY);
			expect(run.bytes).not.toContain("expected_output");
			expect(run.bytes).not.toContain("answer key");
		}
	});

	/**
	 * The observable half of the same property. The directories are removed on scope close and are
	 * absent from the committed manifest, so without this line a real run confirms nothing — which is
	 * what #5437's live-verification criterion asks an operator to do.
	 */
	it("each announce their own directory, so a real run's stderr shows five distinct ones", async () => {
		const {observed, announced} = await stageFiveRuns();

		const isolation = announced.filter((line) => line.includes(ISOLATED_DIR_NOTE));
		expect(isolation).toHaveLength(5);
		expect(new Set(isolation).size).toBe(5);
		for (const run of observed) {
			expect(isolation).toContain(
				`fabrika eval: case 1 run ${run.run}: ${ISOLATED_DIR_NOTE} ${run.dir}`,
			);
		}
	});

	it("are removed when the run's scope closes, so isolation leaves nothing behind", async () => {
		const {observed} = await stageFiveRuns();

		for (const run of observed) expect(existsSync(run.dir)).toBe(false);
	});

	// The majority convention in the corpus: `files` relative to the set's own directory, not the
	// skill root. Both must resolve, or the base this consumer picked silently decides which sets run.
	it("resolve a set-directory-relative fixture as well as a skill-root-relative one", async () => {
		const {observed} = await stageFiveRuns({...gradableCase, files: ["fixtures/eval-1.md"]});

		expect(observed).toHaveLength(5);
		for (const run of observed) {
			expect(run.staged).toEqual(["fixtures", "fixtures/eval-1.md"]);
			expect(run.bytes).toBe(FIXTURE_BODY);
		}
	});

	/**
	 * The compounding half of #5434: a fixture that cannot be staged used to leave a `Staged` empty
	 * directory, so the candidate was spawned without the material its prompt names and the verdict it
	 * produced was still counted. The run must reach `Unstageable` instead, and land in the median as
	 * `unmeasured`.
	 */
	it("score nothing when a declared fixture resolves under no base", async () => {
		const {observed, results} = await stageFiveRuns({
			...gradableCase,
			files: ["fixtures/no-such-case.md"],
		});

		expect(observed).toEqual([]);
		expect(results).toHaveLength(1);
		expect(results[0]?.verdict).toBe("unmeasured");
		expect(results[0]?.noVerdict).toBe(5);
		expect(results[0]?.passed).toBe(0);
	});

	it("score nothing when a declared fixture would escape the run directory", async () => {
		const {observed, results} = await stageFiveRuns({
			...gradableCase,
			files: [FIXTURE, "../evals/cases/eval-2.md"],
		});

		expect(observed).toEqual([]);
		expect(results[0]?.verdict).toBe("unmeasured");
		expect(results[0]?.noVerdict).toBe(5);
	});

	/**
	 * The other door onto the same defect: a case that declares **nothing** used to get a `Staged`
	 * empty directory and score out of it, silently — a `pass`/`fail` no reader could tell from a
	 * measurement. 22 of the corpus's graded cases are this shape and their prompts name material by
	 * path, so an absent declaration must reach `unmeasured` too.
	 */
	it("score nothing when the case declares no `files` at all", async () => {
		const {observed, results} = await stageFiveRuns({...gradableCase, files: null});

		expect(observed).toEqual([]);
		expect(results).toHaveLength(1);
		expect(results[0]?.verdict).toBe("unmeasured");
		expect(results[0]?.noVerdict).toBe(5);
		expect(results[0]?.passed).toBe(0);
	});

	// The other side of that rule, and why it is keyed on the declaration rather than on emptiness: an
	// authored `files: []` IS a claim — this case needs no material — so an empty directory is right.
	it("run in an empty directory when the case declares it needs no material", async () => {
		const {observed, results} = await stageFiveRuns({...gradableCase, files: []});

		expect(observed).toHaveLength(5);
		expect(results[0]?.verdict).toBe("pass");
		for (const run of observed) {
			expect(run.staged).toEqual([]);
			expect(run.bytes).toBe("");
		}
	});

	// The one refusal a run survives: the case still has everything else it declared.
	it("still run when the case declares the answer key, which is withheld", async () => {
		const {observed, results} = await stageFiveRuns({
			...gradableCase,
			files: [FIXTURE, `evals/${EVAL_SET_FILE}`],
		});

		expect(observed).toHaveLength(5);
		expect(results[0]?.verdict).toBe("pass");
		for (const run of observed) {
			expect(run.staged).not.toContain(`evals/${EVAL_SET_FILE}`);
			expect(run.bytes).not.toContain("answer key");
		}
	});
});
