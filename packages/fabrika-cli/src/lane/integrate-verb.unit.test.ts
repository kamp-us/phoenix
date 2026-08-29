/**
 * `lane integrate` — the merged tree's dependencies are reconciled before it is judged, and the
 * assembly branch keeps nothing that did not pass.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	APPEND_UNKNOWN,
	ASSEMBLY_DIRTY,
	ASSEMBLY_RED,
	ASSEMBLY_UNSEATED,
	LANE_UNREADABLE,
	MERGE_CONFLICT,
	PRIMARY_CHECKOUT,
	PROOF_ABSENT,
	RECONCILE_REFUSED,
} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {runIntegrate} from "./integrate-verb.ts";

const ROOT = ".fabrika/lanes";
const EPIC = 7140;
const BRANCH = `epic/${EPIC}`;
const CHILD = "build/7162-tuval-bootstrap-5558c9a2";
const MAIN = "/checkout/phoenix";
const SEAT = `${MAIN}/.claude/worktrees/epic-${EPIC}`;
const BEFORE = "aaaa111";
const AFTER = "bbbb222";

const INSTALL = "pnpm install --frozen-lockfile";
const TYPECHECK = "pnpm typecheck --force";
const CONFIG = JSON.stringify({
	dependencyReconciler: {command: ["pnpm", "install", "--frozen-lockfile"]},
	codeValidators: [{command: ["pnpm", "typecheck", "--force"]}],
});

const LANE_FILES = {
	[`${ROOT}/${EPIC}/workflow.json`]: coderTemplateText(),
	[`${SEAT}/.fabrika.jsonc`]: CONFIG,
};

const LIST = /^git worktree list --porcelain$/;
const BRANCHES = /^git for-each-ref /;
const HEAD = /^git -C .* rev-parse HEAD$/;
const MERGE = /^git -C .* merge --no-ff /;
const ABORT = /^git -C .* merge --abort$/;
const RESET = /^git -C .* reset --hard ORIG_HEAD$/;
const STATUS = /^git -C .* status --porcelain --untracked-files=no$/;
const RECONCILE = /^pnpm install --frozen-lockfile$/;
const VALIDATE = /^pnpm typecheck --force$/;

const listing = (...blocks: ReadonlyArray<readonly [string, string]>): ExecResult =>
	okOut(
		blocks
			.map(([path, branch]) => `worktree ${path}\nHEAD ${BEFORE}\nbranch refs/heads/${branch}\n`)
			.join("\n"),
	);

const SEATED = listing([MAIN, "main"], [SEAT, BRANCH]);
const UNSEATED = listing([MAIN, "main"]);
const CONSCRIPTED = listing([MAIN, BRANCH]);
const HAS_CHILD = okOut(`main\n${BRANCH}\n${CHILD}\n`);

/**
 * The reads every run makes before the merge: the seat, the branch list, the pre-merge head, and the
 * proof the seat was clean when the merge found it.
 *
 * A function rather than a constant because `once` carries its spent flag on the regex it returns,
 * so one shared array would answer the second test's pre-merge read with the third entry. The
 * cleanliness read is `once` for the same reason from the other side: a test scripting a *dirty*
 * post-install status needs its own entry reachable on the second call.
 */
const upToMerge = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[LIST, SEATED],
	[BRANCHES, HAS_CHILD],
	[once(HEAD), okOut(BEFORE)],
	[once(STATUS), okOut("")],
];

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	files: Record<string, string> = LANE_FILES,
	unstartable: ReadonlyArray<RegExp> = [],
) => {
	const shell = fakeShell(script, undefined, unstartable);
	return Effect.runPromise(
		Effect.provide(
			runIntegrate({epic: EPIC, child: CHILD, root: ROOT, lane: String(EPIC)}),
			Layer.merge(shell.layer, fakeFs({files}).layer),
		),
	).then((outcome) => ({outcome, calls: shell.calls, cwds: shell.cwds}));
};

/** The command lines that judge or change the merged tree, in the order they ran. */
const staged = (calls: ReadonlyArray<string>) =>
	calls.filter(
		(line) =>
			line.includes(" merge ") ||
			line.includes("reset --hard") ||
			line === INSTALL ||
			line === TYPECHECK,
	);

describe("runIntegrate", () => {
	it("merges, reconciles from the merged lockfile, then validates — in that order", async () => {
		const {outcome, calls, cwds} = await run([
			...upToMerge(),
			[MERGE, okOut("")],
			[RECONCILE, okOut("")],
			[STATUS, okOut("")],
			[VALIDATE, okOut("")],
			[HEAD, okOut(AFTER)],
		]);

		expect(outcome.code).toBe(0);
		expect(outcome.stdout.trim().split("\n")).toEqual([AFTER, "INTEGRATE-VERDICT: MERGED"]);
		expect(staged(calls)).toEqual([`git -C ${SEAT} merge --no-ff ${CHILD}`, INSTALL, TYPECHECK]);
		// The install is worthless run anywhere else: it must read the lockfile the merge brought.
		expect(cwds[calls.indexOf(INSTALL)]).toBe(SEAT);
		expect(cwds[calls.indexOf(TYPECHECK)]).toBe(SEAT);
	});

	it("never pushes and never writes the lane's log — the answer is a fact about a tree", async () => {
		const {calls} = await run([
			...upToMerge(),
			[MERGE, okOut("")],
			[RECONCILE, okOut("")],
			[STATUS, okOut("")],
			[VALIDATE, okOut("")],
			[HEAD, okOut(AFTER)],
		]);

		expect(calls.some((line) => line.includes("push"))).toBe(false);
	});

	it("resets the merge and runs no validator when the merged lockfile does not install", async () => {
		const {outcome, calls} = await run([
			...upToMerge(),
			[MERGE, okOut("")],
			[RECONCILE, errOut("ERR_PNPM_OUTDATED_LOCKFILE")],
			[RESET, okOut("")],
			[HEAD, okOut(BEFORE)],
		]);

		expect(outcome.code).toBe(RECONCILE_REFUSED);
		expect(outcome.stdout).toBe("");
		expect(staged(calls)).toEqual([
			`git -C ${SEAT} merge --no-ff ${CHILD}`,
			INSTALL,
			`git -C ${SEAT} reset --hard ORIG_HEAD`,
		]);
	});

	it("refuses a reconciliation that could not be executed at all", async () => {
		const {outcome, calls} = await run(
			[...upToMerge(), [MERGE, okOut("")], [RESET, okOut("")], [HEAD, okOut(BEFORE)]],
			LANE_FILES,
			[RECONCILE],
		);

		expect(outcome.code).toBe(RECONCILE_REFUSED);
		expect(calls).toContain(`git -C ${SEAT} reset --hard ORIG_HEAD`);
		expect(calls).not.toContain(TYPECHECK);
	});

	it("refuses an install that repaired the lockfile rather than honouring it", async () => {
		const {outcome, calls} = await run([
			...upToMerge(),
			[MERGE, okOut("")],
			[RECONCILE, okOut("")],
			[STATUS, okOut(" M pnpm-lock.yaml\n")],
			[RESET, okOut("")],
			[HEAD, okOut(BEFORE)],
		]);

		expect(outcome.code).toBe(RECONCILE_REFUSED);
		expect(outcome.stderr.join("\n")).toContain("pnpm-lock.yaml");
		expect(calls).not.toContain(TYPECHECK);
		expect(calls).toContain(`git -C ${SEAT} reset --hard ORIG_HEAD`);
	});

	it("merges nothing into a seat that was already dirty — that dirt is not the child's (#7244)", async () => {
		const {outcome, calls} = await run([
			[LIST, SEATED],
			[BRANCHES, HAS_CHILD],
			[HEAD, okOut(BEFORE)],
			[STATUS, okOut(" M pnpm-lock.yaml\n M packages/tuval/package.json\n")],
		]);

		expect(outcome.code).toBe(ASSEMBLY_DIRTY);
		expect(outcome.stderr.join("\n")).toContain("pnpm-lock.yaml");
		expect(outcome.stderr.join("\n")).toContain("packages/tuval/package.json");
		expect(calls.some((line) => line.includes(" merge "))).toBe(false);
		expect(calls).not.toContain(INSTALL);
		expect(calls).not.toContain(TYPECHECK);
		// Nothing moved the head, so there is nothing to reset — a reset here would be the verb
		// undoing a merge it never made.
		expect(calls).not.toContain(`git -C ${SEAT} reset --hard ORIG_HEAD`);
	});

	it("is UNKNOWN, never a pass, when the seat's cleanliness cannot be read before the merge", async () => {
		const {outcome, calls} = await run([
			[LIST, SEATED],
			[BRANCHES, HAS_CHILD],
			[HEAD, okOut(BEFORE)],
			[STATUS, errOut("fatal: not a git repository")],
		]);

		expect(outcome.code).toBe(LANE_UNREADABLE);
		expect(calls.some((line) => line.includes(" merge "))).toBe(false);
		expect(calls).not.toContain(INSTALL);
	});

	it("proves the seat clean before merging, so the post-install probe diffs against an empty baseline", async () => {
		const {calls} = await run([
			...upToMerge(),
			[MERGE, okOut("")],
			[RECONCILE, okOut("")],
			[STATUS, okOut("")],
			[VALIDATE, okOut("")],
			[HEAD, okOut(AFTER)],
		]);

		const status = `git -C ${SEAT} status --porcelain --untracked-files=no`;
		const merge = `git -C ${SEAT} merge --no-ff ${CHILD}`;
		expect(calls.indexOf(status)).toBeGreaterThan(-1);
		expect(calls.indexOf(status)).toBeLessThan(calls.indexOf(merge));
		expect(calls.filter((line) => line === status)).toHaveLength(2);
	});

	it("aborts a conflicting merge and reconciles nothing — there is no merged tree to judge", async () => {
		const {outcome, calls} = await run([
			...upToMerge(),
			[MERGE, errOut("CONFLICT (content): Merge conflict in packages/tuval/package.json")],
			[ABORT, okOut("")],
			[HEAD, okOut(BEFORE)],
		]);

		expect(outcome.code).toBe(MERGE_CONFLICT);
		expect(calls).toContain(`git -C ${SEAT} merge --abort`);
		expect(calls).not.toContain(INSTALL);
		expect(calls).not.toContain(TYPECHECK);
		expect(calls).not.toContain(`git -C ${SEAT} reset --hard ORIG_HEAD`);
	});

	it("resets the branch on a red validator — the semantic collision, after a good install", async () => {
		const {outcome, calls} = await run([
			...upToMerge(),
			[MERGE, okOut("")],
			[RECONCILE, okOut("")],
			[STATUS, okOut("")],
			[VALIDATE, errOut("src/x.ts(3,1): error TS2345")],
			[RESET, okOut("")],
			[HEAD, okOut(BEFORE)],
		]);

		expect(outcome.code).toBe(ASSEMBLY_RED);
		expect(outcome.stderr.join("\n")).toContain("TS2345");
		expect(staged(calls)).toEqual([
			`git -C ${SEAT} merge --no-ff ${CHILD}`,
			INSTALL,
			TYPECHECK,
			`git -C ${SEAT} reset --hard ORIG_HEAD`,
		]);
	});

	it("is UNKNOWN, never a FAIL, when the reset leaves the merge on the branch", async () => {
		const {outcome} = await run([
			...upToMerge(),
			[MERGE, okOut("")],
			[RECONCILE, okOut("")],
			[STATUS, okOut("")],
			[VALIDATE, errOut("error")],
			[RESET, errOut("fatal: Unable to write new index file")],
			[HEAD, okOut(AFTER)],
		]);

		expect(outcome.code).toBe(APPEND_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("NOT restored");
	});

	it("refuses UNKNOWN when the merged tree's repo declares no code validator", async () => {
		const {outcome, calls} = await run(
			[
				...upToMerge(),
				[MERGE, okOut("")],
				[RECONCILE, okOut("")],
				[STATUS, okOut("")],
				[RESET, okOut("")],
				[HEAD, okOut(BEFORE)],
			],
			{
				...LANE_FILES,
				[`${SEAT}/.fabrika.jsonc`]: JSON.stringify({
					dependencyReconciler: {command: ["pnpm", "install", "--frozen-lockfile"]},
					codeValidators: [],
				}),
			},
		);

		expect(outcome.code).toBe(LANE_UNREADABLE);
		expect(calls).toContain(`git -C ${SEAT} reset --hard ORIG_HEAD`);
	});

	it("skips the install in a repo that declares no reconciler, and still validates", async () => {
		const {outcome, calls} = await run(
			[...upToMerge(), [MERGE, okOut("")], [VALIDATE, okOut("")], [HEAD, okOut(AFTER)]],
			{
				...LANE_FILES,
				[`${SEAT}/.fabrika.jsonc`]: JSON.stringify({
					codeValidators: [{command: ["pnpm", "typecheck", "--force"]}],
				}),
			},
		);

		expect(outcome.code).toBe(0);
		expect(calls).not.toContain(INSTALL);
		expect(calls).toContain(TYPECHECK);
	});

	it("merges nothing when no working tree holds the assembly branch", async () => {
		const {outcome, calls} = await run([
			[LIST, UNSEATED],
			[BRANCHES, HAS_CHILD],
		]);

		expect(outcome.code).toBe(ASSEMBLY_UNSEATED);
		expect(calls.some((line) => line.includes(" merge "))).toBe(false);
	});

	it("refuses the main working tree standing on the assembly branch (#6163)", async () => {
		const {outcome, calls} = await run([[LIST, CONSCRIPTED]]);

		expect(outcome.code).toBe(PRIMARY_CHECKOUT);
		expect(calls.some((line) => line.includes(" merge "))).toBe(false);
	});

	it("refuses a child branch this repository does not carry", async () => {
		const {outcome, calls} = await run([
			[LIST, SEATED],
			[BRANCHES, okOut(`main\n${BRANCH}\n`)],
		]);

		expect(outcome.code).toBe(PROOF_ABSENT);
		expect(calls.some((line) => line.includes(" merge "))).toBe(false);
	});

	it("merges nothing when the pre-merge head cannot be read — there is nowhere to reset back to", async () => {
		const {outcome, calls} = await run([
			[LIST, SEATED],
			[BRANCHES, HAS_CHILD],
			[HEAD, errOut("fatal: ambiguous argument 'HEAD'")],
		]);

		expect(outcome.code).toBe(LANE_UNREADABLE);
		expect(calls.some((line) => line.includes(" merge "))).toBe(false);
	});
});
