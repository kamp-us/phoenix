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
import {replayBranchName} from "./replay.ts";

const ROOT = ".fabrika/lanes";
const EPIC = 7140;
const BRANCH = `epic/${EPIC}`;
const CHILD = "build/7162-app-bootstrap-5558c9a2";
const MAIN = "/checkout/repo";
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

const REPLAY = "cccc333";
const PICK = "dddd444";
const REGISTRY = "flags.ts";
const REPLAY_BRANCH = replayBranchName(CHILD, BEFORE);

const REPLAY_CONFIG = JSON.stringify({
	dependencyReconciler: {command: ["pnpm", "install", "--frozen-lockfile"]},
	codeValidators: [{command: ["pnpm", "typecheck", "--force"]}],
	assemblyReplay: {onCollision: "on"},
});

/** The collision the replay exists for: an append each, where the base had nothing. */
const KEEP_BOTH_CONFLICT = [
	"<<<<<<< HEAD",
	'\tassemblyRefresh: "off",',
	"||||||| parent",
	"=======",
	'\tlaneConcurrencyCap: "4",',
	">>>>>>> the child",
	"",
].join("\n");

/** Two sides editing one text — the arm the replay refuses rather than guesses at. */
const SEMANTIC_CONFLICT = [
	"<<<<<<< HEAD",
	'\texisting: "on",',
	"||||||| parent",
	'\texisting: "maybe",',
	"=======",
	'\texisting: "off",',
	">>>>>>> the child",
	"",
].join("\n");

const REPLAY_FILES = {
	[`${ROOT}/${EPIC}/workflow.json`]: coderTemplateText(),
	[`${SEAT}/.fabrika.jsonc`]: REPLAY_CONFIG,
	[`${SEAT}/${REGISTRY}`]: KEEP_BOTH_CONFLICT,
};

const REV_LIST = /^git -C .* rev-list --reverse /;
const DETACH = /^git -C .* checkout --detach /;
const PICK_START = /^git -C .* -c merge\.conflictStyle=diff3 cherry-pick /;
const PICK_CONTINUE = /^git -C .* -c core\.editor=true cherry-pick --continue$/;
const PICK_ABORT = /^git -C .* cherry-pick --abort$/;
const UNMERGED = /^git -C .* diff --name-only --diff-filter=U$/;
const STAGE = /^git -C .* add -- /;
const NAME_REPLAY = /^git -C .* branch --force /;
const CHECKOUT_BRANCH = new RegExp(`^git -C .* checkout ${BRANCH}$`);
const MERGE_REPLAY = /^git -C .* merge --no-ff --no-edit /;
const RESET_TO_HEAD = new RegExp(`^git -C .* reset --hard ${BEFORE}$`);

/**
 * One whole replay run, from the colliding merge to the validated tree.
 *
 * `tail` replaces the entries after the replay's own merge, which is where the two failure arms this
 * suite drives — a red validator and a restore that will not take — diverge from the green run.
 */
const replayScript = (
	tail: ReadonlyArray<readonly [RegExp, ExecResult]> = [
		[VALIDATE, okOut("")],
		[once(HEAD), okOut(AFTER)],
	],
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	...upToMerge(),
	[once(MERGE), errOut(`CONFLICT (content): Merge conflict in ${REGISTRY}`)],
	[ABORT, okOut("")],
	[once(HEAD), okOut(BEFORE)],
	[REV_LIST, okOut(`${PICK}\n`)],
	[DETACH, okOut("")],
	[PICK_START, errOut(`CONFLICT (content): Merge conflict in ${REGISTRY}`)],
	[UNMERGED, okOut(`${REGISTRY}\n`)],
	[STAGE, okOut("")],
	[PICK_CONTINUE, okOut("")],
	[once(HEAD), okOut(REPLAY)],
	[NAME_REPLAY, okOut("")],
	[CHECKOUT_BRANCH, okOut("")],
	[MERGE_REPLAY, okOut("")],
	[RECONCILE, okOut("")],
	[STATUS, okOut("")],
	...tail,
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

	it("merges nothing into a seat that was already dirty — that dirt is not the child's", async () => {
		const {outcome, calls} = await run([
			[LIST, SEATED],
			[BRANCHES, HAS_CHILD],
			[HEAD, okOut(BEFORE)],
			[STATUS, okOut(" M pnpm-lock.yaml\n M packages/app/package.json\n")],
		]);

		expect(outcome.code).toBe(ASSEMBLY_DIRTY);
		expect(outcome.stderr.join("\n")).toContain("pnpm-lock.yaml");
		expect(outcome.stderr.join("\n")).toContain("packages/app/package.json");
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
			[MERGE, errOut("CONFLICT (content): Merge conflict in packages/app/package.json")],
			[ABORT, okOut("")],
			[HEAD, okOut(BEFORE)],
		]);

		expect(outcome.code).toBe(MERGE_CONFLICT);
		expect(outcome.stderr.join("\n")).toContain("there is no merged tree to judge");
		expect(calls).toContain(`git -C ${SEAT} merge --abort`);
		expect(calls).not.toContain(INSTALL);
		expect(calls).not.toContain(TYPECHECK);
		expect(calls).not.toContain(`git -C ${SEAT} reset --hard ORIG_HEAD`);
		// The shipped `assemblyReplay` is off, so the collision takes the path it always took: no
		// commit of the child's is replayed and nothing beyond the abort touches the seat.
		expect(calls.some((line) => line.includes("cherry-pick"))).toBe(false);
		expect(calls.some((line) => line.includes("rev-list"))).toBe(false);
	});

	it("is UNKNOWN on a collision whose assemblyReplay cannot be read — never the clean refusal", async () => {
		const {outcome, calls} = await run(
			[
				...upToMerge(),
				[MERGE, errOut("CONFLICT (content): Merge conflict in flags.ts")],
				[ABORT, okOut("")],
				[HEAD, okOut(BEFORE)],
			],
			{
				...LANE_FILES,
				[`${SEAT}/.fabrika.jsonc`]: JSON.stringify({assemblyReplay: {onCollision: "sometimes"}}),
			},
		);

		expect(outcome.code).toBe(LANE_UNREADABLE);
		expect(calls.some((line) => line.includes("cherry-pick"))).toBe(false);
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

	describe("with assemblyReplay on", () => {
		it("replays the collision, records the moved range, and asks for one review round", async () => {
			const {outcome, calls} = await run(replayScript(), REPLAY_FILES);

			expect(outcome.code).toBe(0);
			const lines = outcome.stdout.trim().split("\n");
			expect(lines.at(-1)).toBe("INTEGRATE-VERDICT: REPLAYED");
			expect(lines.at(-2)).toBe(AFTER);
			expect(JSON.parse(lines[0] ?? "")).toEqual({
				event: "replayed",
				child: CHILD,
				replay: REPLAY_BRANCH,
				onto: BEFORE,
				range: {from: BEFORE, to: REPLAY},
				resolved: [REGISTRY],
				commits: 1,
				reReview: "required",
				budget: "unspent",
			});
			// The replay is machinery working, not the child failing: nothing here spends a retry.
			expect(calls).toContain(`git -C ${SEAT} merge --no-ff --no-edit ${REPLAY_BRANCH}`);
			expect(calls).toContain(INSTALL);
			expect(calls).toContain(TYPECHECK);
		});

		it("keeps both sides of the conflicted file and stages what it wrote", async () => {
			const shell = fakeShell(replayScript());
			const fs = fakeFs({files: REPLAY_FILES});
			await Effect.runPromise(
				Effect.provide(
					runIntegrate({epic: EPIC, child: CHILD, root: ROOT, lane: String(EPIC)}),
					Layer.merge(shell.layer, fs.layer),
				),
			);

			expect(fs.written.get(`${SEAT}/${REGISTRY}`)).toBe(
				['\tassemblyRefresh: "off",', '\tlaneConcurrencyCap: "4",', ""].join("\n"),
			);
			expect(shell.calls).toContain(`git -C ${SEAT} add -- ${REGISTRY}`);
		});

		it("restores through the captured head, not ORIG_HEAD, when the replay's validators red", async () => {
			const {outcome, calls} = await run(
				[
					...replayScript([[VALIDATE, errOut("src/x.ts(3,1): error TS2345")]]),
					[RESET_TO_HEAD, okOut("")],
					[once(HEAD), okOut(BEFORE)],
				],
				REPLAY_FILES,
			);

			expect(outcome.code).toBe(ASSEMBLY_RED);
			expect(outcome.stdout).toBe("");
			// `git cherry-pick` writes no ORIG_HEAD, so a reset through it would name whatever the last
			// thing that did wrote — the captured sha is the only proven place to go back to.
			expect(calls).toContain(`git -C ${SEAT} reset --hard ${BEFORE}`);
			expect(calls).not.toContain(`git -C ${SEAT} reset --hard ORIG_HEAD`);
		});

		it("is UNKNOWN, never a FAIL, when that restore leaves the replay on the branch", async () => {
			const {outcome} = await run(
				[
					...replayScript([[VALIDATE, errOut("error")]]),
					[RESET_TO_HEAD, errOut("fatal: Unable to write new index file")],
					[once(HEAD), okOut(AFTER)],
				],
				REPLAY_FILES,
			);

			expect(outcome.code).toBe(APPEND_UNKNOWN);
			expect(outcome.stderr.join("\n")).toContain("NOT restored");
		});

		it("parks a hunk that is not a plain keep-both, and proves the branch went back", async () => {
			const {outcome, calls} = await run(
				[
					...upToMerge(),
					[once(MERGE), errOut(`CONFLICT (content): Merge conflict in ${REGISTRY}`)],
					[ABORT, okOut("")],
					[once(HEAD), okOut(BEFORE)],
					[REV_LIST, okOut(`${PICK}\n`)],
					[DETACH, okOut("")],
					[PICK_START, errOut(`CONFLICT (content): Merge conflict in ${REGISTRY}`)],
					[UNMERGED, okOut(`${REGISTRY}\n`)],
					[PICK_ABORT, okOut("")],
					[CHECKOUT_BRANCH, okOut("")],
					[RESET_TO_HEAD, okOut("")],
					[once(HEAD), okOut(BEFORE)],
				],
				{...REPLAY_FILES, [`${SEAT}/${REGISTRY}`]: SEMANTIC_CONFLICT},
			);

			expect(outcome.code).toBe(MERGE_CONFLICT);
			expect(outcome.stderr.join("\n")).toContain("--cause replay-conflict");
			expect(outcome.stderr.join("\n")).toContain("editing one text");
			expect(calls).toContain(`git -C ${SEAT} cherry-pick --abort`);
			expect(calls).toContain(`git -C ${SEAT} reset --hard ${BEFORE}`);
			expect(calls).not.toContain(INSTALL);
			expect(calls).not.toContain(TYPECHECK);
		});

		it("is UNKNOWN when the pick stops and the unmerged paths cannot be read", async () => {
			const {outcome, calls} = await run(
				[
					...upToMerge(),
					[once(MERGE), errOut("CONFLICT")],
					[ABORT, okOut("")],
					[once(HEAD), okOut(BEFORE)],
					[REV_LIST, okOut(`${PICK}\n`)],
					[DETACH, okOut("")],
					[PICK_START, errOut("CONFLICT")],
					[UNMERGED, errOut("fatal: not a git repository")],
					[PICK_ABORT, okOut("")],
					[CHECKOUT_BRANCH, okOut("")],
				],
				REPLAY_FILES,
			);

			expect(outcome.code).toBe(APPEND_UNKNOWN);
			expect(calls).not.toContain(INSTALL);
		});
	});

	it("merges nothing when no working tree holds the assembly branch", async () => {
		const {outcome, calls} = await run([
			[LIST, UNSEATED],
			[BRANCHES, HAS_CHILD],
		]);

		expect(outcome.code).toBe(ASSEMBLY_UNSEATED);
		expect(calls.some((line) => line.includes(" merge "))).toBe(false);
	});

	it("refuses the main working tree standing on the assembly branch", async () => {
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
