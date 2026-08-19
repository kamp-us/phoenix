/** `lane assembly` — the run's own worktree is placed, resumed or removed, and never the driver's. */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {runAssembly} from "./assembly-verb.ts";
import {APPEND_UNKNOWN, LANE_ABSENT, LANE_UNREADABLE, PRIMARY_CHECKOUT} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";

const ROOT = ".fabrika/lanes";
const EPIC = 5680;
const BRANCH = `epic/${EPIC}`;
const MAIN = "/checkout/phoenix";
const EXPECTED = `${MAIN}/.claude/worktrees/epic-${EPIC}`;
const LANE_FILES = {[`${ROOT}/${EPIC}/workflow.json`]: coderTemplateText()};

const LIST = /^git worktree list --porcelain$/;
const ADD = /^git worktree add /;
const REMOVE = /^git worktree remove /;
const FETCH = /^git fetch /;

const listing = (...blocks: ReadonlyArray<readonly [string, string | null]>): ExecResult =>
	okOut(
		blocks
			.map(
				([path, branch]) =>
					`worktree ${path}\nHEAD aaaa111\n${branch === null ? "detached" : `branch refs/heads/${branch}`}\n`,
			)
			.join("\n"),
	);

const CLEAN = listing([MAIN, "main"]);
const SEATED = listing([MAIN, "main"], [EXPECTED, BRANCH]);
const CONSCRIPTED = listing([MAIN, BRANCH]);

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	remove = false,
	files: Record<string, string> = LANE_FILES,
) => {
	const shell = fakeShell(script);
	return Effect.runPromise(
		Effect.provide(
			runAssembly({epic: EPIC, remove, root: ROOT, lane: String(EPIC)}),
			Layer.merge(shell.layer, fakeFs({files}).layer),
		),
	).then((outcome) => ({outcome, calls: shell.calls}));
};

describe("runAssembly", () => {
	it("places the run's worktree off origin/HEAD and answers its path, switching no checkout", async () => {
		const {outcome, calls} = await run([
			[once(LIST), CLEAN],
			[LIST, SEATED],
			[FETCH, okOut("")],
			[ADD, okOut("")],
			[/^git remote set-head /, okOut("")],
		]);

		expect(outcome.code).toBe(0);
		expect(outcome.stdout.trim()).toBe(EXPECTED);
		expect(calls).toContain(`git worktree add -b ${BRANCH} ${EXPECTED} origin/HEAD`);
		expect(calls.some((line) => line.startsWith("git switch"))).toBe(false);
	});

	it("resumes an already-placed worktree and writes nothing", async () => {
		const {outcome, calls} = await run([[LIST, SEATED]]);

		expect(outcome.code).toBe(0);
		expect(outcome.stdout.trim()).toBe(EXPECTED);
		expect(calls.some((line) => line.startsWith("git worktree add"))).toBe(false);
		expect(calls.some((line) => line.startsWith("git fetch"))).toBe(false);
	});

	it("refuses the main working tree standing on the assembly branch, placing nothing (#6163)", async () => {
		const {outcome, calls} = await run([[LIST, CONSCRIPTED]]);

		expect(outcome.code).toBe(PRIMARY_CHECKOUT);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain(MAIN);
		expect(calls.some((line) => line.startsWith("git worktree add"))).toBe(false);
	});

	it("is UNKNOWN, never a placement, when the working trees cannot be read", async () => {
		const {outcome, calls} = await run([[LIST, errOut("not a git repository")]]);

		expect(outcome.code).toBe(LANE_UNREADABLE);
		expect(calls).toEqual(["git worktree list --porcelain"]);
	});

	it("reports a placement that did not land rather than answering the path it meant to make", async () => {
		const {outcome} = await run([
			[LIST, CLEAN],
			[FETCH, okOut("")],
			[ADD, errOut("fatal: could not create work tree dir")],
		]);

		expect(outcome.code).toBe(APPEND_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("NOT placed");
	});

	it("never cuts the assembly branch off a stale base — a failed fetch places nothing", async () => {
		const {outcome, calls} = await run([
			[LIST, CLEAN],
			[FETCH, errOut("network is unreachable")],
		]);

		expect(outcome.code).toBe(LANE_UNREADABLE);
		expect(calls.some((line) => line.startsWith("git worktree add"))).toBe(false);
	});

	it("removes the run's worktree at terminal, without --force", async () => {
		const {outcome, calls} = await run(
			[
				[once(LIST), SEATED],
				[LIST, CLEAN],
				[REMOVE, okOut("")],
			],
			true,
		);

		expect(outcome.code).toBe(0);
		expect(calls).toContain(`git worktree remove ${EXPECTED}`);
		expect(calls.some((line) => line.includes("--force"))).toBe(false);
	});

	it("tolerates a removal with nothing to remove, answering where the worktree belonged", async () => {
		const {outcome, calls} = await run([[LIST, CLEAN]], true);

		expect(outcome.code).toBe(0);
		expect(outcome.stdout.trim()).toBe(EXPECTED);
		expect(calls.some((line) => line.startsWith("git worktree remove"))).toBe(false);
	});

	it("reports a removal that left the tree in place — git refusing a dirty tree is the answer", async () => {
		const {outcome} = await run(
			[
				[LIST, SEATED],
				[REMOVE, errOut("fatal: contains modified or untracked files")],
			],
			true,
		);

		expect(outcome.code).toBe(APPEND_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("NOT removed");
	});

	it("refuses a lane that was never emitted, before it touches any working tree", async () => {
		const {outcome, calls} = await run([[LIST, CLEAN]], false, {});

		expect(outcome.code).toBe(LANE_ABSENT);
		expect(calls).toEqual([]);
	});
});
