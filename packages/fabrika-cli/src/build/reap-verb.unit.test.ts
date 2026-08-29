import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, once, type Scripted} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN} from "./codes.ts";
import {runReap} from "./reap-verb.ts";

const SELF = /^git rev-parse --path-format=absolute/;
const TREES = /^git worktree list --porcelain$/;
const TRUNK = /^git symbolic-ref --short refs\/remotes\/origin\/HEAD$/;
const STATUS = /^git -C \S+ --no-optional-locks status --porcelain$/;
const ANCESTOR = /^git merge-base --is-ancestor /;
const DIFF = /^git diff .* origin\/main\.\.\./;
const NAMES = /^git diff .*--name-only/;
const MERGE_BASE = /^git merge-base origin\/main /;
const LOG = /^git log --no-merges -p /;
const PATCH_ID = /^git patch-id --stable$/;
const REMOVE = /^git worktree remove /;

const HERE = "/repo/.claude/worktrees/agent-self";
const DEAD = "/repo/.claude/worktrees/agent-dead";
const OTHER = "/repo/.claude/worktrees/agent-other";
const LANDED = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AHEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

interface Record {
	readonly path: string;
	readonly head?: string;
	readonly branch?: string;
	readonly locked?: string | null;
	readonly prunable?: boolean;
}

/** `git worktree list --porcelain`, as the blocks git prints for each registration. */
const trees = (...records: ReadonlyArray<Record>) =>
	okOut(
		records
			.map((r) =>
				[
					`worktree ${r.path}`,
					`HEAD ${r.head ?? LANDED}`,
					r.branch === undefined ? "detached" : `branch refs/heads/${r.branch}`,
					...(r.locked === undefined || r.locked === null
						? []
						: [r.locked === "" ? "locked" : `locked ${r.locked}`]),
					...(r.prunable === true ? ["prunable gitdir file points to non-existent location"] : []),
				].join("\n"),
			)
			.join("\n\n"),
	);

/** The primary checkout is always registered, and is never in the population. */
const PRIMARY: Record = {path: "/repo", branch: "main"};

/** What `git rev-parse` names for THIS run's checkout — the tree no sweep may remove. */
const here = okOut([`${HERE}/.git`, HERE].join("\n"));

const GROUND: ReadonlyArray<Scripted> = [
	[SELF, here],
	[TRUNK, okOut("origin/main\n")],
];

const run = (script: ReadonlyArray<Scripted>, execute = false) => {
	const shell = fakeShell(script as ReadonlyArray<readonly [RegExp, never]>);
	return Effect.runPromise(Effect.provide(runReap({execute}), shell.layer)).then((out) => ({
		out,
		calls: shell.calls,
	}));
};

describe("runReap — the dry run mutates nothing", () => {
	it("classifies a clean, unlocked, landed tree REMOVE and removes nothing", async () => {
		const {out, calls} = await run([
			...GROUND,
			[TREES, trees(PRIMARY, {path: DEAD})],
			[STATUS, okOut("")],
			[ANCESTOR, okOut("")],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "planned",
			executed: false,
			trunk: "origin/main",
			scanned: 1,
			removable: [{path: DEAD, license: "ancestor"}],
			kept: [],
		});
		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
		expect(out.stderr.join("\n")).toMatch(/re-run with --execute/);
	});

	it("reads another tree's status WITHOUT refreshing its index", async () => {
		const {calls} = await run([
			...GROUND,
			[TREES, trees(PRIMARY, {path: DEAD})],
			[STATUS, okOut("")],
			[ANCESTOR, okOut("")],
		]);

		expect(calls).toContain(`git -C ${DEAD} --no-optional-locks status --porcelain`);
	});

	it("names both halves of the report — what would go and what is kept", async () => {
		const {out} = await run([
			...GROUND,
			[TREES, trees(PRIMARY, {path: DEAD}, {path: OTHER, head: AHEAD})],
			[STATUS, okOut("")],
			[new RegExp(`^git merge-base --is-ancestor ${LANDED} `), okOut("")],
			[ANCESTOR, errOut("exit 1")],
			[NAMES, okOut("x\0")],
			[DIFF, okOut("diff --git a/x b/x\n@@\n+x\n")],
			[PATCH_ID, okOut("ffff 0000\n")],
			[MERGE_BASE, okOut(`${LANDED}\n`)],
			[LOG, okOut("")],
		]);

		const report = out.stderr.join("\n");
		expect(report).toMatch(new RegExp(`REMOVE ${DEAD}`));
		expect(report).toMatch(new RegExp(`KEEP ${OTHER}`));
		expect(JSON.parse(out.stdout).kept).toMatchObject([{path: OTHER}]);
	});
});

describe("runReap — what the trunk proves", () => {
	it("reaps a squash-landed branch whose patch id matches a trunk commit's", async () => {
		const {out} = await run(
			[
				...GROUND,
				[once(TREES), trees(PRIMARY, {path: DEAD, head: AHEAD, branch: "build/4082-x-43cc"})],
				[STATUS, okOut("")],
				[ANCESTOR, errOut("exit 1")],
				[NAMES, okOut("packages/db-schema/README.md\0")],
				[DIFF, okOut("diff --git a/README b/README\n@@\n+a\n")],
				[once(PATCH_ID), okOut("d18b491 0000000\n")],
				[MERGE_BASE, okOut(`${LANDED}\n`)],
				[LOG, okOut("commit 99ef1f6\ndiff --git a/README b/README\n@@\n+a\n")],
				[PATCH_ID, okOut("d18b491 99ef1f6\n")],
				[REMOVE, okOut("")],
				[TREES, trees(PRIMARY)],
			],
			true,
		);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).removed).toMatchObject([{path: DEAD, license: "squashed"}]);
	});

	it("keeps a tree whose patch matches nothing on the trunk", async () => {
		const {out, calls} = await run(
			[
				...GROUND,
				[TREES, trees(PRIMARY, {path: DEAD, head: AHEAD})],
				[STATUS, okOut("")],
				[ANCESTOR, errOut("exit 1")],
				[NAMES, okOut("x\0")],
				[DIFF, okOut("diff --git a/x b/x\n@@\n+x\n")],
				[once(PATCH_ID), okOut("ffff 0000\n")],
				[MERGE_BASE, okOut(`${LANDED}\n`)],
				[LOG, okOut("commit 99ef1f6\ndiff --git a/x b/x\n@@\n+y\n")],
				[PATCH_ID, okOut("eeee 99ef1f6\n")],
			],
			true,
		);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "reaped", removed: []});
		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
	});

	it("keeps a tree whose landing read failed — UNKNOWN is never 'landed'", async () => {
		const {out, calls} = await run(
			[
				...GROUND,
				[TREES, trees(PRIMARY, {path: DEAD, head: AHEAD})],
				[STATUS, okOut("")],
				[ANCESTOR, errOut("exit 1")],
				[DIFF, errOut("bad object")],
			],
			true,
		);

		expect(JSON.parse(out.stdout).kept).toMatchObject([{path: DEAD}]);
		expect(out.stderr.join("\n")).toMatch(/UNKNOWN/);
		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
	});
});

describe("runReap — one unreadable tree costs its own row, not the sweep", () => {
	it("keeps the tree whose status failed and still reaps the readable one", async () => {
		const {out} = await run(
			[
				...GROUND,
				[once(TREES), trees(PRIMARY, {path: DEAD}, {path: OTHER})],
				[new RegExp(`^git -C ${DEAD} `), errOut("not a git repository")],
				[STATUS, okOut("")],
				[ANCESTOR, okOut("")],
				[REMOVE, okOut("")],
				[TREES, trees(PRIMARY, {path: DEAD})],
			],
			true,
		);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "reaped",
			removed: [{path: OTHER}],
			kept: [{path: DEAD}],
		});
	});
});

describe("runReap — the removals are proven, never reported", () => {
	it("removes WITHOUT --force — ADR 0321 bans it on every path", async () => {
		const {calls} = await run(
			[
				...GROUND,
				[once(TREES), trees(PRIMARY, {path: DEAD})],
				[STATUS, okOut("")],
				[ANCESTOR, okOut("")],
				[REMOVE, okOut("")],
				[TREES, trees(PRIMARY)],
			],
			true,
		);

		expect(calls.filter((line) => REMOVE.test(line))).toEqual([`git worktree remove ${DEAD}`]);
		expect(calls.some((line) => line.includes("--force"))).toBe(false);
	});

	it("reports a refused removal, leaves the tree registered, and still counts the one that went", async () => {
		const {out} = await run(
			[
				...GROUND,
				[once(TREES), trees(PRIMARY, {path: DEAD}, {path: OTHER})],
				[STATUS, okOut("")],
				[ANCESTOR, okOut("")],
				[new RegExp(`^git worktree remove ${DEAD}$`), errOut("cannot remove a locked tree")],
				[REMOVE, okOut("")],
				[TREES, trees(PRIMARY, {path: DEAD})],
			],
			true,
		);

		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
		const report = out.stderr.join("\n");
		expect(report).toMatch(new RegExp(`FAILED to remove ${DEAD}: cannot remove a locked tree`));
		expect(report).toMatch(new RegExp(`removed ${OTHER}`));
	});

	it("is READBACK_MISMATCH when git exits 0 and the registration survives", async () => {
		const {out} = await run(
			[
				...GROUND,
				[once(TREES), trees(PRIMARY, {path: DEAD})],
				[STATUS, okOut("")],
				[ANCESTOR, okOut("")],
				[REMOVE, okOut("")],
				[TREES, trees(PRIMARY, {path: DEAD})],
			],
			true,
		);

		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.join("\n")).toMatch(/UNPROVEN/);
	});

	it("is READBACK_MISMATCH when the registrations cannot be read back at all", async () => {
		const {out} = await run(
			[
				...GROUND,
				[once(TREES), trees(PRIMARY, {path: DEAD})],
				[STATUS, okOut("")],
				[ANCESTOR, okOut("")],
				[REMOVE, okOut("")],
				[TREES, errOut("index.lock exists")],
			],
			true,
		);

		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.join("\n")).toMatch(/NOT proven/);
	});
});

describe("runReap — what it refuses to touch", () => {
	it("never removes the tree this run is standing in", async () => {
		const {out, calls} = await run(
			[
				...GROUND,
				[TREES, trees(PRIMARY, {path: HERE})],
				[STATUS, okOut("")],
				[ANCESTOR, okOut("")],
			],
			true,
		);

		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
		expect(out.stderr.join("\n")).toMatch(/standing in/);
	});

	it("answers none — never a refusal — when no agent tree is registered", async () => {
		const {out, calls} = await run([...GROUND, [TREES, trees(PRIMARY)]]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "none", removed: [], kept: []});
		expect(calls.some((line) => TRUNK.test(line))).toBe(false);
	});

	it("is UNKNOWN when this run cannot recognise its own tree", async () => {
		const {out, calls} = await run([[SELF, errOut("not a git repository")]]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(calls.some((line) => TREES.test(line))).toBe(false);
	});

	it("is UNKNOWN when the registrations cannot be read", async () => {
		const {out} = await run([
			[SELF, here],
			[TREES, errOut("index.lock exists")],
		]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toMatch(/UNKNOWN/);
	});

	it("is UNKNOWN — and reaps nothing — when the trunk cannot be named", async () => {
		const {out, calls} = await run(
			[
				[SELF, here],
				[TREES, trees(PRIMARY, {path: DEAD})],
				[TRUNK, errOut("ref refs/remotes/origin/HEAD is not a symbolic ref")],
			],
			true,
		);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toMatch(/remote set-head/);
		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
	});
});
