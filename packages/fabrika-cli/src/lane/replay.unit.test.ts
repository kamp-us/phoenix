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

const run = (script: ReadonlyArray<readonly [RegExp, ExecResult]>) => {
	const shell = fakeShell(script);
	return Effect.runPromise(
		Effect.provide(
			replayChild({path: SEAT, branch: BRANCH, child: CHILD, tip: TIP}),
			Layer.merge(shell.layer, fakeFs({files: {}}).layer),
		),
	).then((outcome) => ({outcome, calls: shell.calls}));
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
