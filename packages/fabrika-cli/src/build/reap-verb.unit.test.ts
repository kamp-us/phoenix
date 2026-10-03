import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {
	errOut,
	type FakeFsOptions,
	fakeFs,
	fakeSeams,
	okOut,
	once,
	type Scripted,
} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {FAILED} from "../verb.ts";
import {PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN} from "./codes.ts";
import {issue} from "./fixtures.test-support.ts";
import {REAP_JOURNAL, runReap} from "./reap-verb.ts";

const SELF = /^git rev-parse --path-format=absolute/;
const TREES = /^git worktree list --porcelain$/;
/** The one trunk read — GitHub's default branch for the repo the env names. */
const TRUNK = /^GET \S+\/repos\/o\/r$/;
const STATUS = /^git -C \S+ --no-optional-locks status --porcelain$/;
const ANCESTOR = /^git merge-base --is-ancestor /;
const DIFF = /^git diff .* origin\/main\.\.\./;
const NAMES = /^git diff .*--name-only/;
const MERGE_BASE = /^git merge-base origin\/main /;
const LOG = /^git log --no-merges -p /;
const PATCH_ID = /^git patch-id --stable$/;
const SHALLOW = /^git rev-parse --is-shallow-repository$/;
const REMOVE = /^git worktree remove /;
const PRUNE = /^git worktree prune$/;
const UNLOCK = /^git worktree unlock /;
const REVLIST = /^git -C \S+ rev-list --count HEAD --not --branches --remotes --tags$/;
const ADD = /^git -C \S+ add --all$/;
const SALVAGE = /^git -C \S+ commit --no-verify/;
/** Every board read the sweep can make: the pull requests on a branch, and one issue. */
const PULLS = /^GET \S+\/repos\/o\/r\/pulls\?state=all&head=/;
const ISSUE = /^GET \S+\/repos\/o\/r\/issues\/\d+$/;
const BOARD = /\/repos\/o\/r\/(pulls|issues)/;

/** What the trunk scan answers for a HEAD it does not carry, down to a patch that matches nothing. */
const UNLANDED: ReadonlyArray<Scripted> = [
	[ANCESTOR, errOut("exit 1")],
	[NAMES, okOut("x\0")],
	[DIFF, okOut("diff --git a/x b/x\n@@\n+x\n")],
	[PATCH_ID, okOut("ffff 0000\n")],
	[MERGE_BASE, okOut(`${"a".repeat(40)}\n`)],
	[LOG, okOut("")],
];

const pullsOn = (...rows: ReadonlyArray<{number: number; state: string; merged?: boolean}>) => ({
	status: 200,
	body: JSON.stringify(
		rows.map((row) => ({
			number: row.number,
			state: row.state,
			merged_at: row.merged === true ? "2026-09-30T00:00:00Z" : null,
			head: {sha: "b".repeat(40)},
			created_at: "2026-09-29T00:00:00Z",
		})),
	),
});

/** The repo and credential the trunk read resolves against. */
const ENV = {CLAUDE_PIPELINE_REPO: "o/r", GITHUB_TOKEN: "ghp_scripted"};

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
	[TRUNK, {status: 200, body: JSON.stringify({default_branch: "main"})}],
];

const ago = (seconds: number): Date => new Date(Date.now() - seconds * 1000);

/** Every tree in the default fixture is a month cold, so the git facts alone decide its verdict. */
const QUIET_FS: FakeFsOptions = {
	directories: [HERE, DEAD, OTHER],
	mtimes: {[HERE]: ago(2_592_000), [DEAD]: ago(2_592_000), [OTHER]: ago(2_592_000)},
};

/** Where a sweep standing in {@link HERE} appends its removals. */
const JOURNAL = `${HERE}/${REAP_JOURNAL}`;

const run = (
	script: ReadonlyArray<Scripted>,
	execute = false,
	fs: FakeFsOptions = QUIET_FS,
	limit: number | null = null,
) => {
	const shell = fakeSeams(script);
	const disk = fakeFs(fs);
	const layer = Layer.merge(shell.layer, disk.layer);
	return Effect.runPromise(Effect.provide(runReap({execute, limit, env: ENV}), layer)).then(
		(out) => ({
			out,
			calls: shell.calls,
			requests: shell.requests,
			journal: disk.written.get(JOURNAL) ?? "",
		}),
	);
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
			...UNLANDED,
			[REVLIST, okOut("2\n")],
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

	it("keeps unreached commits whose patch matches nothing on the trunk", async () => {
		const {out, calls} = await run(
			[
				...GROUND,
				[TREES, trees(PRIMARY, {path: DEAD, head: AHEAD})],
				[STATUS, okOut("")],
				[REVLIST, okOut("1\n")],
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

	it("keeps unreached commits whose landing read failed — UNKNOWN is never 'landed'", async () => {
		const {out, calls} = await run(
			[
				...GROUND,
				[TREES, trees(PRIMARY, {path: DEAD, head: AHEAD})],
				[STATUS, okOut("")],
				[REVLIST, okOut("1\n")],
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
		[REVLIST, okOut("1\n")],
		[ANCESTOR, errOut("exit 1")],
		[DIFF, okOut("diff --git a/x b/x\n@@\n+x\n")],
		[PATCH_ID, okOut("ffff 0000\n")],
		[NAMES, okOut("x\0")],
		[MERGE_BASE, errOut("git merge-base exited 1")],
		[SHALLOW, shallow],
	];

	/** git's own reason, closed by the bracket the KEEP reason quotes it in — no remedy after it. */
	const BARE =
		"(whether its work landed is UNKNOWN: it shares no merge base with origin/main: git merge-base exited 1)";

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

		expect(keptReason(out)).toContain(BARE);
	});

	// A probe that cannot answer names an unreadable read no more precisely — and never less.
	it("carries git's reason alone when the shallow probe itself fails", async () => {
		const {out} = await run(beyondBoundary(errOut("rev-parse blew up")));

		expect(keptReason(out)).toContain(BARE);
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
		const {out, calls} = await run(seat, true, {directories: [HERE], unstatable: [DEAD]});

		expect(JSON.parse(out.stdout).kept).toMatchObject([{path: DEAD}]);
		expect(out.stderr.join("\n")).toMatch(/whether its directory is still there is UNKNOWN/);
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
				unstatable: [DEAD],
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
		expect(out.stderr.join("\n")).toMatch(/neither is proven/);
	});
});

describe("runReap — the stale registrations go in the same pass", () => {
	/**
	 * The stat is what proves {@link DEAD} absent. Every fixture below still prints git's `prunable`
	 * line, because git does print it for this state — the point is that the verb reaches the same
	 * verdict without reading it.
	 */
	const GONE_FS: FakeFsOptions = {
		directories: [HERE, OTHER],
		mtimes: {[HERE]: ago(2_592_000), [OTHER]: ago(2_592_000)},
		unprobeable: [DEAD],
	};

	const gone: ReadonlyArray<Scripted> = [
		...GROUND,
		[once(TREES), trees(PRIMARY, {path: DEAD, prunable: true})],
		[PRUNE, okOut("")],
		[TREES, trees(PRIMARY)],
	];

	it("plans a PRUNE for a registration whose directory the stat proves gone, and prunes nothing", async () => {
		const {out, calls} = await run(
			[...GROUND, [TREES, trees(PRIMARY, {path: DEAD, prunable: true})]],
			false,
			GONE_FS,
		);

		expect(JSON.parse(out.stdout)).toMatchObject({answer: "planned", stale: [{path: DEAD}]});
		expect(out.stderr.join("\n")).toMatch(new RegExp(`PRUNE ${DEAD}`));
		expect(calls.some((line) => PRUNE.test(line))).toBe(false);
	});

	// git reports `prunable` off the worktree's `.git` FILE, so it fires over a checkout that is
	// still on disk and still dirty (measured in ./stale-registration.git.test.ts). Seating Gone on
	// that flag cleared such a record — and `.git/worktrees/<id>` with it, the only ref a commit
	// living in that worktree alone has.
	it("keeps a prunable registration whose directory is still there — the flag is a hint, the stat is the proof", async () => {
		const {out, calls} = await run([
			...GROUND,
			[TREES, trees(PRIMARY, {path: DEAD, prunable: true})],
			[STATUS, okOut(" M unsaved.txt\n")],
		]);

		expect(JSON.parse(out.stdout)).toMatchObject({answer: "planned", stale: [], removable: []});
		expect(out.stderr.join("\n")).toMatch(new RegExp(`KEEP ${DEAD}`));
		expect(calls.some((line) => PRUNE.test(line))).toBe(false);
	});

	it("pays no git read for it — a registration with no directory has nothing to ask git about", async () => {
		const {calls} = await run(
			[...GROUND, [TREES, trees(PRIMARY, {path: DEAD, prunable: true})]],
			false,
			GONE_FS,
		);

		expect(calls.some((line) => STATUS.test(line))).toBe(false);
		expect(calls.some((line) => ANCESTOR.test(line))).toBe(false);
	});

	it("prunes it under --execute and proves it off the read-back", async () => {
		const {out, calls} = await run(gone, true, GONE_FS);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "reaped", pruned: [DEAD], unpruned: []});
		expect(calls).toContain("git worktree prune");
		expect(out.stderr.join("\n")).toMatch(new RegExp(`pruned the stale registration ${DEAD}`));
	});

	it("unlocks a locked one first — prune skips a locked entry, and this lock guards no checkout", async () => {
		const {calls} = await run(
			[
				...GROUND,
				[once(TREES), trees(PRIMARY, {path: DEAD, locked: "claude agent (pid 84894)"})],
				[UNLOCK, okOut("")],
				[PRUNE, okOut("")],
				[TREES, trees(PRIMARY)],
			],
			true,
			{directories: [HERE], unprobeable: [DEAD]},
		);

		expect(calls).toContain(`git worktree unlock ${DEAD}`);
		expect(calls.indexOf(`git worktree unlock ${DEAD}`)).toBeLessThan(
			calls.indexOf("git worktree prune"),
		);
	});

	it("reports an unlock git refused, leaves that registration standing, and reds nothing", async () => {
		const {out, calls} = await run(
			[
				...GROUND,
				[once(TREES), trees(PRIMARY, {path: DEAD, locked: "claude agent (pid 84894)"})],
				[UNLOCK, errOut("permission denied")],
				[PRUNE, okOut("")],
				[TREES, trees(PRIMARY, {path: DEAD, locked: "claude agent (pid 84894)"})],
			],
			true,
			{directories: [HERE], unprobeable: [DEAD]},
		);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({pruned: [], unpruned: [DEAD]});
		expect(out.stderr.join("\n")).toMatch(
			new RegExp(`FAILED to unlock ${DEAD}: permission denied`),
		);
		// The prune still runs: a refused unlock costs its own entry, never the pass.
		expect(calls).toContain("git worktree prune");
	});

	it("reports a registration that survived the prune without redding the sweep", async () => {
		const {out} = await run(
			[
				...GROUND,
				[once(TREES), trees(PRIMARY, {path: DEAD, prunable: true})],
				[PRUNE, okOut("")],
				[TREES, trees(PRIMARY, {path: DEAD, prunable: true})],
			],
			true,
			GONE_FS,
		);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({pruned: [], unpruned: [DEAD]});
		expect(out.stderr.join("\n")).toMatch(new RegExp(`UNPRUNED — ${DEAD}`));
	});

	it("reports a prune git refused, and no tree removal is affected", async () => {
		const {out} = await run(
			[
				...GROUND,
				[once(TREES), trees(PRIMARY, {path: DEAD, prunable: true})],
				[PRUNE, errOut("permission denied")],
				[TREES, trees(PRIMARY, {path: DEAD, prunable: true})],
			],
			true,
			GONE_FS,
		);

		expect(out.stderr.join("\n")).toMatch(/FAILED to prune: permission denied/);
	});

	it("clears what a removal just left behind — one clone-wide prune ends the pass", async () => {
		const {calls} = await run(
			[
				...GROUND,
				[once(TREES), trees(PRIMARY, {path: DEAD})],
				[STATUS, okOut("")],
				[ANCESTOR, okOut("")],
				[REMOVE, okOut("")],
				[PRUNE, okOut("")],
				[TREES, trees(PRIMARY)],
			],
			true,
		);

		expect(calls).toContain("git worktree prune");
	});
});

describe("runReap — the population is both harness namings", () => {
	const PI = "/private/tmp/worktrees/slug/pi-worktree-0036baa5-s0-0";

	it("sweeps a tree the harness named its own way, outside the repository entirely", async () => {
		const {out} = await run(
			[...GROUND, [TREES, trees(PRIMARY, {path: PI})], [STATUS, okOut("")], [ANCESTOR, okOut("")]],
			false,
			{
				directories: [HERE, PI],
				mtimes: {[HERE]: ago(2_592_000), [PI]: ago(2_592_000)},
			},
		);

		expect(JSON.parse(out.stdout)).toMatchObject({scanned: 1, removable: [{path: PI}]});
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
		const {out, requests} = await run([...GROUND, [TREES, trees(PRIMARY)]]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "none", removed: [], kept: []});
		expect(requests.some((line) => TRUNK.test(line))).toBe(false);
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

	it("refuses a --limit that is not a positive integer before it reads anything", async () => {
		for (const limit of [0, -1, 2.5]) {
			const {out, calls} = await run([[SELF, here]], true, QUIET_FS, limit);

			expect(out.code).toBe(FAILED);
			expect(calls).toEqual([]);
			expect(out.stderr.join("\n")).toMatch(new RegExp(`--limit "${limit}"`));
		}
	});

	it("is UNKNOWN — and reaps nothing — when the trunk cannot be named", async () => {
		const {out, calls} = await run(
			[
				[SELF, here],
				[TREES, trees(PRIMARY, {path: DEAD})],
				[TRUNK, {status: 502, body: '{"message":"Bad Gateway"}'}],
			],
			true,
		);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toMatch(/cannot resolve the trunk/);
		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
	});
});

const journalRows = (journal: string): ReadonlyArray<{readonly [key: string]: unknown}> =>
	journal
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line) as {readonly [key: string]: unknown});

/** A two-tree sweep, both removable, whose second half the caller scripts. */
const twoRemovable = (...tail: ReadonlyArray<Scripted>): ReadonlyArray<Scripted> => [
	...GROUND,
	[once(TREES), trees(PRIMARY, {path: DEAD}, {path: OTHER})],
	[STATUS, okOut("")],
	[ANCESTOR, okOut("")],
	...tail,
];

describe("runReap — the journal is what survives a killed sweep", () => {
	it("appends one line per removal, naming the run, the trunk, the path and its license", async () => {
		const {out, journal} = await run(
			twoRemovable([REMOVE, okOut("")], [TREES, trees(PRIMARY)]),
			true,
		);

		expect(out.code).toBe(0);
		const lines = journalRows(journal);
		expect(lines).toMatchObject([
			{trunk: "origin/main", path: DEAD, license: "ancestor"},
			{trunk: "origin/main", path: OTHER, license: "ancestor"},
		]);
		expect(new Set(lines.map((row) => row.run)).size).toBe(1);
		expect(JSON.parse(out.stdout).journal).toBe(JOURNAL);
	});

	// The incident shape: the terminal answer is composed after the loop, so a run that never
	// reaches it prints nothing at all. The disk is the only place the executed set can be read from,
	// and a refusal is the closest a runnable verb comes to a process that was killed.
	it("holds the executed set even when the run's own answer names none of it", async () => {
		const {out, journal} = await run(
			twoRemovable([REMOVE, okOut("")], [TREES, errOut("index.lock exists")]),
			true,
		);

		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stdout).toBe("");
		expect(journalRows(journal)).toMatchObject([{path: DEAD}, {path: OTHER}]);
	});

	it("keeps a proven removal proven when its journal write fails, and says so", async () => {
		const {out} = await run(twoRemovable([REMOVE, okOut("")], [TREES, trees(PRIMARY)]), true, {
			...QUIET_FS,
			unwritable: [JOURNAL],
		});

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).removed).toMatchObject([{path: DEAD}, {path: OTHER}]);
		expect(out.stderr.join("\n")).toMatch(new RegExp(`NOT JOURNALLED — ${DEAD} was removed`));
	});
});

describe("runReap — a clean tree a ref reaches goes on git's word alone", () => {
	it("removes it with no board read, though the trunk does not carry its HEAD", async () => {
		const {out, requests} = await run(
			[
				...GROUND,
				[once(TREES), trees(PRIMARY, {path: DEAD, head: AHEAD, branch: "build/4082-x-43cc4b51"})],
				[STATUS, okOut("")],
				...UNLANDED,
				[REVLIST, okOut("0\n")],
				[REMOVE, okOut("")],
				[TREES, trees(PRIMARY)],
			],
			true,
		);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).removed).toEqual([
			{path: DEAD, license: "ref-reached", salvaged: 0},
		]);
		expect(requests.some((line) => BOARD.test(line))).toBe(false);
	});
});

describe("runReap — the board releases what a tree still holds", () => {
	const LANE = "build/8572-editor-focus-43cc4b51";
	/** A quiet tree on a lane branch, holding three uncommitted paths. */
	const dirty = (branch: string = LANE): ReadonlyArray<Scripted> => [
		...GROUND,
		[once(TREES), trees(PRIMARY, {path: DEAD, head: AHEAD, branch})],
		[STATUS, okOut(" M a.ts\n M b.ts\n?? c.ts\n")],
		...UNLANDED,
		[REVLIST, okOut("0\n")],
	];
	const mutated = (calls: ReadonlyArray<string>): boolean =>
		calls.some((line) => REMOVE.test(line) || ADD.test(line) || SALVAGE.test(line));

	it("commits the uncommitted paths onto the branch, then removes plainly, when its pull request is merged", async () => {
		const {out, calls, journal} = await run(
			[
				...dirty(),
				[PULLS, pullsOn({number: 8580, state: "closed", merged: true})],
				[ADD, okOut("")],
				[SALVAGE, okOut("")],
				[REMOVE, okOut("")],
				[TREES, trees(PRIMARY)],
			],
			true,
		);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).removed).toEqual([
			{path: DEAD, license: "branch-ended", salvaged: 3},
		]);
		expect(calls.findIndex((line) => SALVAGE.test(line))).toBeLessThan(
			calls.indexOf(`git worktree remove ${DEAD}`),
		);
		expect(calls.some((line) => line.includes("--force"))).toBe(false);
		expect(journalRows(journal)).toMatchObject([{license: "branch-ended", salvaged: 3}]);
	});

	it("removes it when its pull request is closed unmerged", async () => {
		const {out} = await run(
			[
				...dirty(),
				[PULLS, pullsOn({number: 8580, state: "closed"})],
				[ADD, okOut("")],
				[SALVAGE, okOut("")],
				[REMOVE, okOut("")],
				[TREES, trees(PRIMARY)],
			],
			true,
		);

		expect(JSON.parse(out.stdout).removed).toMatchObject([{license: "branch-ended"}]);
	});

	it("removes it when no pull request has the branch and the issue it is named for is closed", async () => {
		const {out} = await run(
			[
				...dirty("epic/8160"),
				[PULLS, pullsOn()],
				[ISSUE, issue({number: 8160, state: "closed"})],
				[ADD, okOut("")],
				[SALVAGE, okOut("")],
				[REMOVE, okOut("")],
				[TREES, trees(PRIMARY)],
			],
			true,
		);

		expect(JSON.parse(out.stdout).removed).toMatchObject([{license: "branch-ended"}]);
	});

	it("keeps it while a pull request on the branch is open, naming the count and the live branch", async () => {
		const {out, calls} = await run(
			[...dirty(), [PULLS, pullsOn({number: 8580, state: "open"})]],
			true,
		);

		expect(JSON.parse(out.stdout).kept[0].reason).toMatch(
			/3 uncommitted path\(s\), and its branch is live: pull request \S+ on \S+ is open/,
		);
		expect(mutated(calls)).toBe(false);
	});

	it("keeps it when the board does not answer — a failed read proves nothing", async () => {
		const {out, calls} = await run(
			[...dirty(), [PULLS, {status: 502, body: '{"message":"Bad Gateway"}'}]],
			true,
		);

		expect(JSON.parse(out.stdout).kept[0].reason).toMatch(
			/merged or closed is not proven: the pull requests on \S+ could not be read/,
		);
		expect(mutated(calls)).toBe(false);
	});

	// The founder's long-running desk, were it ever named like an agent tree: detached, dirty,
	// months old, made by no lane. There is no branch to ask about, so the board is never read.
	it("keeps a detached, dirty, long-lived tree no lane made, and asks the board nothing", async () => {
		const {out, calls, requests} = await run(
			[
				...GROUND,
				[TREES, trees(PRIMARY, {path: DEAD})],
				[STATUS, okOut(" M .fabrika.jsonc\n?? desk.log\n")],
				[ANCESTOR, okOut("")],
				[REVLIST, okOut("0\n")],
			],
			true,
		);

		expect(JSON.parse(out.stdout).kept[0].reason).toMatch(
			/2 uncommitted path\(s\).*it holds no branch/,
		);
		expect(requests.some((line) => BOARD.test(line))).toBe(false);
		expect(mutated(calls)).toBe(false);
	});

	it("leaves the tree standing when the salvage commit fails, and never removes it", async () => {
		const {out, calls} = await run(
			[
				...dirty(),
				[PULLS, pullsOn({number: 8580, state: "closed", merged: true})],
				[ADD, okOut("")],
				[SALVAGE, errOut("index.lock exists")],
			],
			true,
		);

		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.join("\n")).toMatch(/could not be committed onto \S+ first: index.lock/);
		expect(calls.some((line) => REMOVE.test(line))).toBe(false);
	});

	it("plans the removal on a dry run and touches nothing", async () => {
		const {out, calls} = await run([
			...dirty(),
			[TREES, trees(PRIMARY, {path: DEAD, head: AHEAD, branch: LANE})],
			[PULLS, pullsOn({number: 8580, state: "closed", merged: true})],
		]);

		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "planned",
			removable: [{path: DEAD, license: "branch-ended"}],
		});
		expect(mutated(calls)).toBe(false);
	});
});

describe("runReap — --limit bounds the sweep", () => {
	it("stops reading trees the moment its removals are spent", async () => {
		const THIRD = "/repo/.claude/worktrees/agent-third";
		const FOURTH = "/repo/.claude/worktrees/agent-fourth";
		const all = [DEAD, OTHER, THIRD, FOURTH];
		const {out, calls, journal} = await run(
			[
				...GROUND,
				[once(TREES), trees(PRIMARY, ...all.map((path) => ({path})))],
				[STATUS, okOut("")],
				[ANCESTOR, okOut("")],
				[REMOVE, okOut("")],
				[TREES, trees(PRIMARY, {path: THIRD}, {path: FOURTH})],
			],
			true,
			{
				directories: [HERE, ...all],
				mtimes: Object.fromEntries(all.map((p) => [p, ago(2_592_000)])),
			},
			2,
		);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "reaped",
			scanned: 2,
			unscanned: 2,
			removed: [{path: DEAD}, {path: OTHER}],
		});
		// The trees past the second removal were never given a git read of any kind.
		expect(calls.filter((line) => STATUS.test(line))).toEqual([
			`git -C ${DEAD} --no-optional-locks status --porcelain`,
			`git -C ${OTHER} --no-optional-locks status --porcelain`,
		]);
		expect(calls.filter((line) => ANCESTOR.test(line))).toHaveLength(2);
		// And the first tree went before the second was read.
		expect(calls.indexOf(`git worktree remove ${DEAD}`)).toBeLessThan(
			calls.indexOf(`git -C ${OTHER} --no-optional-locks status --porcelain`),
		);
		expect(journalRows(journal)).toMatchObject([{path: DEAD}, {path: OTHER}]);
		expect(out.stderr.join("\n")).toMatch(
			/--limit 2 was spent with 2 of 4 tree\(s\) still unjudged/,
		);
	});

	// Clearing a stale registration is not bounded: prune skips a locked entry, so one past the
	// bound would outlive every bounded pass unless its absence is still read and its lock dropped.
	it("still unlocks and prunes a locked, gone registration past a spent bound", async () => {
		const GONE = "/repo/.claude/worktrees/agent-gone";
		const LIVE = "/repo/.claude/worktrees/agent-live";
		const lock = "claude agent (pid 84894)";
		const {out, calls, requests} = await run(
			[
				...GROUND,
				[
					once(TREES),
					trees(PRIMARY, {path: DEAD}, {path: OTHER}, {path: GONE, locked: lock}, {path: LIVE}),
				],
				[STATUS, okOut("")],
				[ANCESTOR, okOut("")],
				[REMOVE, okOut("")],
				[UNLOCK, okOut("")],
				[PRUNE, okOut("")],
				[TREES, trees(PRIMARY, {path: OTHER}, {path: LIVE})],
			],
			true,
			{
				directories: [HERE, DEAD, OTHER, LIVE],
				mtimes: Object.fromEntries([DEAD, OTHER, LIVE].map((p) => [p, ago(2_592_000)])),
				unprobeable: [GONE],
			},
			1,
		);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			removed: [{path: DEAD}],
			pruned: [GONE],
			unpruned: [],
			unscanned: 2,
		});
		expect(calls.indexOf(`git worktree unlock ${GONE}`)).toBeGreaterThan(-1);
		expect(calls.indexOf(`git worktree unlock ${GONE}`)).toBeLessThan(
			calls.indexOf("git worktree prune"),
		);
		// The stat is all a tree past the bound is given: no git read reaches the other two.
		expect(calls.filter((line) => STATUS.test(line))).toEqual([
			`git -C ${DEAD} --no-optional-locks status --porcelain`,
		]);
		expect(calls.filter((line) => ANCESTOR.test(line))).toHaveLength(1);
		expect(calls.filter((line) => REVLIST.test(line)).every((line) => line.includes(DEAD))).toBe(
			true,
		);
		expect(requests.some((line) => BOARD.test(line))).toBe(false);
	});

	it("names the bound on a dry run without narrowing what it calls removable", async () => {
		const {out} = await run(
			twoRemovable([TREES, trees(PRIMARY, {path: DEAD}, {path: OTHER})]),
			false,
			QUIET_FS,
			1,
		);

		expect(JSON.parse(out.stdout).removable).toMatchObject([{path: DEAD}, {path: OTHER}]);
		expect(out.stderr.join("\n")).toMatch(/--limit 1 bounds this sweep to 1 of 2 removable/);
	});
});
