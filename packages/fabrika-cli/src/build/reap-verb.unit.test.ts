import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {
	errOut,
	type FakeFsOptions,
	fakeFs,
	fakeShell,
	okOut,
	once,
	type Scripted,
} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
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
const SHALLOW = /^git rev-parse --is-shallow-repository$/;
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

const ago = (seconds: number): Date => new Date(Date.now() - seconds * 1000);

/** Every tree in the default fixture is a month cold, so the git facts alone decide its verdict. */
const QUIET_FS: FakeFsOptions = {
	directories: [HERE, DEAD, OTHER],
	mtimes: {[HERE]: ago(2_592_000), [DEAD]: ago(2_592_000), [OTHER]: ago(2_592_000)},
};

const run = (script: ReadonlyArray<Scripted>, execute = false, fs: FakeFsOptions = QUIET_FS) => {
	const shell = fakeShell(script as ReadonlyArray<readonly [RegExp, never]>);
	const layer = Layer.merge(shell.layer, fakeFs(fs).layer);
	return Effect.runPromise(Effect.provide(runReap({execute}), layer)).then((out) => ({
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

/**
 * The merge base bounds the trunk scan, so a shallow clone's graft boundary stops the landing read
 * before it starts. The tree is KEEP either way — the finding this seam was repaired for is that its
 * reason names the one cause an operator can fix locally, the way the assembly read already did.
 */
describe("runReap — an unreachable merge base names its remedy when there is one", () => {
	const beyondBoundary = (shallow: ExecResult): ReadonlyArray<Scripted> => [
		...GROUND,
		[TREES, trees(PRIMARY, {path: DEAD, head: AHEAD})],
		[STATUS, okOut("")],
		[ANCESTOR, errOut("exit 1")],
		[DIFF, okOut("diff --git a/x b/x\n@@\n+x\n")],
		[PATCH_ID, okOut("ffff 0000\n")],
		[NAMES, okOut("x\0")],
		[MERGE_BASE, errOut("git merge-base exited 1")],
		[SHALLOW, shallow],
	];

	const keptReason = (out: {readonly stdout: string}): string =>
		JSON.parse(out.stdout).kept[0]?.reason ?? "";

	it("names the shallow clone and `git fetch --unshallow origin`", async () => {
		const {out} = await run(beyondBoundary(okOut("true\n")));

		const reason = keptReason(out);
		expect(reason).toContain("this clone is shallow");
		expect(reason).toContain("git fetch --unshallow origin");
		// The probe proves shallowness, not causation — git's own words are the evidence that
		// corrects the hypothesis when the cause is an absent ref or an unrelated history.
		expect(reason).toContain("git merge-base exited 1");
	});

	it("carries git's reason alone when the clone is not shallow", async () => {
		const {out} = await run(beyondBoundary(okOut("false\n")));

		expect(keptReason(out)).toBe(
			"whether its work landed is UNKNOWN: it shares no merge base with origin/main: git merge-base exited 1",
		);
	});

	// A probe that cannot answer names an unreadable read no more precisely — and never less.
	it("carries git's reason alone when the shallow probe itself fails", async () => {
		const {out} = await run(beyondBoundary(errOut("rev-parse blew up")));

		expect(keptReason(out)).toBe(
			"whether its work landed is UNKNOWN: it shares no merge base with origin/main: git merge-base exited 1",
		);
	});
});

describe("runReap — a live seat is read off the tree, not off git", () => {
	/** The incident shape: a seat's tree, clean, unlocked, HEAD on the trunk, touched minutes ago. */
	const seat: ReadonlyArray<Scripted> = [
		...GROUND,
		[TREES, trees(PRIMARY, {path: DEAD})],
		[STATUS, okOut("")],
		[ANCESTOR, okOut("")],
	];

	it("keeps it, and never asks git to remove it", async () => {
		const {out, calls} = await run(seat, true, {
			directories: [HERE, DEAD],
			mtimes: {[HERE]: ago(2_592_000), [DEAD]: ago(2_400)},
		});

		expect(JSON.parse(out.stdout)).toMatchObject({answer: "reaped", removed: []});
		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
		expect(out.stderr.join("\n")).toMatch(
			new RegExp(`KEEP ${DEAD} \\(detached\\) — it reads live`),
		);
	});

	it("names the signal that held, so the plan says why the seat survived", async () => {
		const {out} = await run(seat, false, {
			directories: [HERE, DEAD],
			mtimes: {[HERE]: ago(2_592_000), [DEAD]: ago(2_400)},
		});

		expect(JSON.parse(out.stdout).kept[0].reason).toMatch(
			/directory was last written 40m ago, inside the 1d quiet window/,
		);
	});

	it("keeps it when its directory cannot be stat'd at all — UNKNOWN never licenses a removal", async () => {
		const {out, calls} = await run(seat, true, {directories: [HERE], unprobeable: [DEAD]});

		expect(JSON.parse(out.stdout).kept).toMatchObject([{path: DEAD}]);
		expect(out.stderr.join("\n")).toMatch(/whether it is still in use is UNKNOWN/);
		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
	});

	it("keeps it when the platform reports no modification time", async () => {
		const {out} = await run(seat, false, {directories: [HERE, DEAD]});

		expect(JSON.parse(out.stdout).kept[0].reason).toMatch(/no modification time/);
	});

	it("removes the same tree once it has gone cold", async () => {
		const {out} = await run(
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

		expect(JSON.parse(out.stdout).removed).toMatchObject([{path: DEAD, license: "ancestor"}]);
	});

	it("one tree's failed liveness read costs its own row, not the sweep", async () => {
		const {out} = await run(
			[
				...GROUND,
				[once(TREES), trees(PRIMARY, {path: DEAD}, {path: OTHER})],
				[STATUS, okOut("")],
				[ANCESTOR, okOut("")],
				[REMOVE, okOut("")],
				[TREES, trees(PRIMARY, {path: DEAD})],
			],
			true,
			{
				directories: [HERE, OTHER],
				unprobeable: [DEAD],
				mtimes: {[HERE]: ago(2_592_000), [OTHER]: ago(2_592_000)},
			},
		);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "reaped",
			removed: [{path: OTHER}],
			kept: [{path: DEAD}],
		});
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
	it("removes WITHOUT --force — it is banned on every path", async () => {
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
