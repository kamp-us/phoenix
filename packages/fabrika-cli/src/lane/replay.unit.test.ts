/**
 * The replay leg's arms a real git will not produce on demand: a checkout that will not take, a
 * branch that cannot be named, a replayed range that still conflicts with the tip it was built on.
 *
 * The whole green path and both content arms run against real git in `replay.git.test.ts` beside
 * this file — that split is the one `review/range-durability.git.test.ts` documents: a claim about
 * what git does is measured, and a claim about what this module does with a failed read is scripted.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import type {LockfileRegenerator} from "../config/keys/assembly-replay.ts";
import {errOut, fakeFs, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {replayBranchName, replayChild} from "./replay.ts";

const SEAT = "/checkout/repo/.claude/worktrees/epic-7140";
const BRANCH = "epic/7140";
const CHILD = "build/7162-app-bootstrap-5558c9a2";
const TIP = "aaaa111aaaa111aaaa111aaaa111aaaa111aaaa1";
const PICK = "dddd444";
const REPLAY = "cccc333";

const REV_LIST = /^git -C .* rev-list --reverse /;
const DETACH = /^git -C .* checkout --detach /;
const PICK_START = /^git -C .* -c merge\.conflictStyle=diff3 cherry-pick /;
const HEAD = /^git -C .* rev-parse HEAD$/;
const NAME_REPLAY = /^git -C .* branch --force /;
const CHECKOUT_BRANCH = new RegExp(`^git -C .* checkout ${BRANCH}$`);
const MERGE_REPLAY = /^git -C .* merge --no-ff --no-edit /;
const MERGE_ABORT = /^git -C .* merge --abort$/;

/** A pick that applies clean, so every test below fails somewhere other than the content. */
const cleanPick = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[REV_LIST, okOut(`${PICK}\n`)],
	[DETACH, okOut("")],
	[PICK_START, okOut("")],
	[once(HEAD), okOut(REPLAY)],
];

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	{
		regenerator = null,
		files = {},
		unstartable = [],
	}: {
		readonly regenerator?: LockfileRegenerator | null;
		readonly files?: Record<string, string>;
		readonly unstartable?: ReadonlyArray<RegExp>;
	} = {},
) => {
	const shell = fakeShell(script, undefined, unstartable);
	return Effect.runPromise(
		Effect.provide(
			replayChild({path: SEAT, branch: BRANCH, child: CHILD, tip: TIP, regenerator}),
			Layer.merge(shell.layer, fakeFs({files}).layer),
		),
	).then((outcome) => ({outcome, calls: shell.calls, cwds: shell.cwds}));
};

describe("replayBranchName", () => {
	it("carries both operands, so a replay onto a moved tip is a different branch", () => {
		expect(replayBranchName(CHILD, TIP)).toBe(
			`replay/build-7162-app-bootstrap-5558c9a2-onto-${TIP.slice(0, 7)}`,
		);
		expect(replayBranchName(CHILD, "bbbb222bbbb")).not.toBe(replayBranchName(CHILD, TIP));
	});
});

describe("replayChild", () => {
	it("names the replayed range and merges it into the assembly branch", async () => {
		const {outcome, calls} = await run([
			...cleanPick(),
			[NAME_REPLAY, okOut("")],
			[CHECKOUT_BRANCH, okOut("")],
			[MERGE_REPLAY, okOut("")],
		]);

		expect(outcome).toEqual({
			_tag: "Replayed",
			replayBranch: replayBranchName(CHILD, TIP),
			range: {from: TIP, to: REPLAY},
			commits: 1,
			resolved: [],
			regenerated: [],
		});
		expect(calls).toContain(
			`git -C ${SEAT} branch --force ${replayBranchName(CHILD, TIP)} ${REPLAY}`,
		);
	});

	it("is UNKNOWN when the commits the child adds cannot be listed", async () => {
		const {outcome, calls} = await run([[REV_LIST, errOut("fatal: bad revision")]]);

		expect(outcome._tag).toBe("Unreadable");
		expect(calls.some((line) => line.includes("checkout --detach"))).toBe(false);
	});

	it("is UNKNOWN when the seat will not detach, and picks nothing", async () => {
		const {outcome, calls} = await run([
			[REV_LIST, okOut(`${PICK}\n`)],
			[DETACH, errOut("error: Your local changes would be overwritten")],
		]);

		expect(outcome._tag).toBe("Unreadable");
		expect(calls.some((line) => line.includes("cherry-pick"))).toBe(false);
	});

	// The seat is detached here, and a caller's restore describes a branch — so this is UNKNOWN even
	// though the refusal that reached it was going to be one.
	it("is UNKNOWN when the seat cannot be put back on its branch after a stopped pick", async () => {
		const {outcome} = await run([
			[REV_LIST, okOut(`${PICK}\n`)],
			[DETACH, okOut("")],
			[PICK_START, errOut("CONFLICT")],
			[/diff --name-only/, okOut("")],
			[/cherry-pick --abort/, okOut("")],
			[CHECKOUT_BRANCH, errOut("error: pathspec did not match")],
		]);

		expect(outcome._tag).toBe("Unreadable");
		if (outcome._tag === "Unreadable") expect(outcome.reason).toContain("detached");
	});

	// A checkout takes while a pick is still in progress, so the abort's own exit is what tells a
	// clean seat from one whose next pick refuses — the caller's hard reset clears neither.
	it("is UNKNOWN when the pick will not abort and the seat still carries one", async () => {
		const {outcome, calls} = await run([
			[REV_LIST, okOut(`${PICK}\n`)],
			[DETACH, okOut("")],
			[PICK_START, errOut("CONFLICT")],
			[/diff --name-only/, okOut("")],
			[/cherry-pick --abort/, errOut("error: cannot abort from a branch yet to be born")],
			[/rev-parse --verify --quiet CHERRY_PICK_HEAD/, okOut(`${PICK}\n`)],
		]);

		expect(outcome._tag).toBe("Unreadable");
		if (outcome._tag === "Unreadable") expect(outcome.reason).toContain("would not abort");
		expect(calls.some((line) => line.includes(`checkout ${BRANCH}`))).toBe(false);
	});

	// A pick that never started leaves nothing to abort and says so — that refusal is not the defect.
	it("keeps the content refusal when the abort failed because no pick survives", async () => {
		const {outcome} = await run([
			[REV_LIST, okOut(`${PICK}\n`)],
			[DETACH, okOut("")],
			[PICK_START, errOut("fatal: bad object")],
			[/diff --name-only/, okOut("")],
			[/cherry-pick --abort/, errOut("error: no cherry-pick in progress")],
			[/rev-parse --verify --quiet CHERRY_PICK_HEAD/, errOut("")],
			[CHECKOUT_BRANCH, okOut("")],
		]);

		expect(outcome._tag).toBe("NotKeepBoth");
	});

	it("is UNKNOWN when the replayed range cannot be named", async () => {
		const {outcome} = await run([
			...cleanPick(),
			[NAME_REPLAY, errOut("fatal: cannot force update")],
		]);

		expect(outcome._tag).toBe("Unreadable");
	});

	// A range built on this tip cannot conflict with it, so a merge that does says the seat is not
	// what this leg believes it is — never a content answer to hand back.
	it("aborts and is UNKNOWN when the replayed range still conflicts with the tip", async () => {
		const {outcome, calls} = await run([
			...cleanPick(),
			[NAME_REPLAY, okOut("")],
			[CHECKOUT_BRANCH, okOut("")],
			[MERGE_REPLAY, errOut("CONFLICT (content)")],
			[MERGE_ABORT, okOut("")],
		]);

		expect(outcome._tag).toBe("Unreadable");
		expect(calls).toContain(`git -C ${SEAT} merge --abort`);
	});
});

describe("replayChild over a lockfile collision", () => {
	const LOCK = "pnpm-lock.yaml";
	const MANIFEST = "package.json";
	const REGENERATOR: LockfileRegenerator = {
		argv: ["pnpm", "install", "--lockfile-only"],
		lockfiles: [LOCK],
	};
	const REGENERATE_LINE = "pnpm install --lockfile-only";

	const UNMERGED = /^git -C .* diff --name-only --diff-filter=U$/;
	const ATTRIBUTES = /^git -C .* check-attr -z merge -- /;
	const REGENERATE = /^pnpm install --lockfile-only$/;
	const WORKTREE_CHANGES = /^git -C .* diff --name-only$/;
	const STAGE = /^git -C .* add -- /;
	const CONTINUE = /^git -C .* -c core\.editor=true cherry-pick --continue$/;
	const ABORT_PICK = /^git -C .* cherry-pick --abort$/;

	const attrs = (...rows: ReadonlyArray<readonly [string, string]>): ExecResult =>
		okOut(rows.map(([file, value]) => `${file}\0merge\0${value}\0`).join(""));

	/** A binary merge leaves "ours" in place with no markers — the file keep-both cannot read. */
	const LOCK_FILES = {[`${SEAT}/${LOCK}`]: "lockfileVersion: '9.0'\n"};

	/** The pick stops on the named unmerged paths, before anything resolves them. */
	const stoppedOn = (
		...paths: ReadonlyArray<string>
	): ReadonlyArray<readonly [RegExp, ExecResult]> => [
		[REV_LIST, okOut(`${PICK}\n`)],
		[DETACH, okOut("")],
		[PICK_START, errOut(`CONFLICT (content): Merge conflict in ${paths[0]}`)],
		[UNMERGED, okOut(`${paths.join("\n")}\n`)],
	];

	/** Everything after a resolved pick: the replayed head named, merged and reseated. */
	const landed = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
		[CONTINUE, okOut("")],
		[once(HEAD), okOut(REPLAY)],
		[NAME_REPLAY, okOut("")],
		[CHECKOUT_BRANCH, okOut("")],
		[MERGE_REPLAY, okOut("")],
	];

	/** A refused pick put back on its branch. */
	const putBack = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
		[ABORT_PICK, okOut("")],
		[CHECKOUT_BRANCH, okOut("")],
	];

	it("regenerates a lockfile-only collision in the seat, stages it and continues the pick", async () => {
		const {outcome, calls, cwds} = await run(
			[
				...stoppedOn(LOCK),
				[ATTRIBUTES, attrs([LOCK, "binary"])],
				[REGENERATE, okOut("")],
				[WORKTREE_CHANGES, okOut(`${LOCK}\n`)],
				[STAGE, okOut("")],
				...landed(),
			],
			{regenerator: REGENERATOR, files: LOCK_FILES},
		);

		expect(outcome).toEqual({
			_tag: "Replayed",
			replayBranch: replayBranchName(CHILD, TIP),
			range: {from: TIP, to: REPLAY},
			commits: 1,
			resolved: [],
			regenerated: [LOCK],
		});
		expect(cwds[calls.indexOf(REGENERATE_LINE)]).toBe(SEAT);
		expect(calls.indexOf(`git -C ${SEAT} add -- ${LOCK}`)).toBeGreaterThan(
			calls.indexOf(REGENERATE_LINE),
		);
		expect(calls.indexOf(`git -C ${SEAT} add -- ${LOCK}`)).toBeLessThan(
			calls.findIndex((line) => CONTINUE.test(line)),
		);
	});

	it("refuses a mixed collision exactly as it does with no regenerator declared", async () => {
		const script = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
			...stoppedOn(LOCK, MANIFEST),
			[ATTRIBUTES, attrs([LOCK, "binary"], [MANIFEST, "unspecified"])],
			...putBack(),
		];
		const files = {...LOCK_FILES, [`${SEAT}/${MANIFEST}`]: '{"name": "x"}\n'};

		const declared = await run(script(), {regenerator: REGENERATOR, files});
		const undeclared = await run(script(), {regenerator: null, files});

		expect(declared.outcome._tag).toBe("NotKeepBoth");
		expect(declared.outcome).toEqual(undeclared.outcome);
		expect(declared.calls).not.toContain(REGENERATE_LINE);
	});

	it("refuses a lockfile-only collision as before when no regenerator is declared", async () => {
		const {outcome, calls} = await run([...stoppedOn(LOCK), ...putBack()], {
			regenerator: null,
			files: LOCK_FILES,
		});

		expect(outcome).toEqual({
			_tag: "NotKeepBoth",
			reason: `${LOCK}: the file carries no conflict markers — a delete/modify or a binary collision, which no textual resolution reaches`,
			paths: [LOCK],
		});
		// Nothing new runs: the attributes are never read and no command is spawned.
		expect(calls.some((line) => ATTRIBUTES.test(line))).toBe(false);
		expect(calls).not.toContain(REGENERATE_LINE);
	});

	it("leaves a declared lockfile that is not `merge=binary` to the keep-both judgment", async () => {
		const {outcome, calls} = await run(
			[...stoppedOn(LOCK), [ATTRIBUTES, attrs([LOCK, "unspecified"])], ...putBack()],
			{regenerator: REGENERATOR, files: LOCK_FILES},
		);

		expect(outcome._tag).toBe("NotKeepBoth");
		expect(calls).not.toContain(REGENERATE_LINE);
	});

	it("abandons the replay naming the command and the lockfile when the regenerator fails", async () => {
		const {outcome, calls} = await run(
			[
				...stoppedOn(LOCK),
				[ATTRIBUTES, attrs([LOCK, "binary"])],
				[REGENERATE, errOut("ERR_PNPM_NO_MATCHING_VERSION No matching version")],
				...putBack(),
			],
			{regenerator: REGENERATOR, files: LOCK_FILES},
		);

		expect(outcome._tag).toBe("NotRegenerated");
		if (outcome._tag !== "NotRegenerated") return;
		expect(outcome.reason).toContain(REGENERATE_LINE);
		expect(outcome.reason).toContain(LOCK);
		expect(outcome.paths).toEqual([LOCK]);
		expect(calls).toContain(`git -C ${SEAT} cherry-pick --abort`);
		expect(calls).toContain(`git -C ${SEAT} checkout ${BRANCH}`);
		expect(calls.some((line) => STAGE.test(line))).toBe(false);
	});

	it("abandons the replay naming the command and the lockfile when the regenerator cannot start", async () => {
		const {outcome, calls} = await run(
			[...stoppedOn(LOCK), [ATTRIBUTES, attrs([LOCK, "binary"])], ...putBack()],
			{regenerator: REGENERATOR, files: LOCK_FILES, unstartable: [REGENERATE]},
		);

		expect(outcome._tag).toBe("NotRegenerated");
		if (outcome._tag !== "NotRegenerated") return;
		expect(outcome.reason).toContain(`\`${REGENERATE_LINE}\` could not be executed`);
		expect(outcome.reason).toContain(LOCK);
		expect(calls).toContain(`git -C ${SEAT} checkout ${BRANCH}`);
	});

	it("refuses a regenerator that also rewrote a tracked file beside the lockfile", async () => {
		const {outcome, calls} = await run(
			[
				...stoppedOn(LOCK),
				[ATTRIBUTES, attrs([LOCK, "binary"])],
				[REGENERATE, okOut("")],
				[WORKTREE_CHANGES, okOut(`${LOCK}\n${MANIFEST}\n`)],
				...putBack(),
			],
			{regenerator: REGENERATOR, files: LOCK_FILES},
		);

		expect(outcome._tag).toBe("NotRegenerated");
		if (outcome._tag !== "NotRegenerated") return;
		expect(outcome.reason).toContain(MANIFEST);
		expect(calls.some((line) => STAGE.test(line))).toBe(false);
	});

	it("is UNKNOWN when which paths are `merge=binary` cannot be read", async () => {
		const {outcome, calls} = await run(
			[...stoppedOn(LOCK), [ATTRIBUTES, errOut("fatal: bad attribute")], ...putBack()],
			{regenerator: REGENERATOR, files: LOCK_FILES},
		);

		expect(outcome._tag).toBe("Unreadable");
		expect(calls).not.toContain(REGENERATE_LINE);
	});
});
