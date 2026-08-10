import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {GROUND, groundScript} from "./fixtures.test-support.ts";
import {
	COMPARED_FIELDS,
	comparableOf,
	compareGround,
	DIGESTED_FIELDS,
	deriveChecks,
	deriveGitCore,
	deriveGround,
	deriveTree,
	digestOf,
	driftState,
	fieldAt,
	parseAheadBehind,
	parseGround,
	preImage,
	resolveBranch,
} from "./ground.ts";

/** The contract's worked example, transcribed so the pre-image below is a comparison, not a claim. */
const WORKED = {
	issue: 5021,
	repo: "kamp-us/phoenix",
	git: {
		branch: "umut/fanout-helper",
		head: "4f1c8a2b9d3e5607182934abcdef5566778899aa",
		upstream: "origin/umut/fanout-helper",
		reachable: "pushed" as const,
		aheadBy: 0,
		behindBy: 0,
		base: {branch: "main", head: "11223344556677889900aabbccddeeff00112233"},
		tree: {state: "clean" as const, trackedModified: 0, untracked: 0},
	},
	board: {
		issue: {state: "open", labels: ["p2", "type:chore"]},
		pull: {
			number: 5290,
			state: "open",
			head: "4f1c8a2b9d3e5607182934abcdef5566778899aa",
			checks: "failing" as const,
		},
	},
};

const run = <A>(
	effect: Effect.Effect<A, never, ChildProcessSpawner.ChildProcessSpawner>,
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, fakeShell(script).layer));

describe("the digest pre-image", () => {
	it("is the nineteen fields, in order, as the contract prints them", () => {
		expect(preImage(WORKED)).toBe(
			[
				"issue=5021",
				'repo="kamp-us/phoenix"',
				'git.branch="umut/fanout-helper"',
				'git.head="4f1c8a2b9d3e5607182934abcdef5566778899aa"',
				'git.upstream="origin/umut/fanout-helper"',
				'git.reachable="pushed"',
				"git.aheadBy=0",
				"git.behindBy=0",
				'git.base.branch="main"',
				'git.base.head="11223344556677889900aabbccddeeff00112233"',
				'git.tree.state="clean"',
				"git.tree.trackedModified=0",
				"git.tree.untracked=0",
				'board.issue.state="open"',
				'board.issue.labels=["p2","type:chore"]',
				"board.pull.number=5290",
				'board.pull.state="open"',
				'board.pull.head="4f1c8a2b9d3e5607182934abcdef5566778899aa"',
				'board.pull.checks="failing"',
			].join("\n"),
		);
	});

	it("carries null on all four board.pull rows together when there is no pull request", () => {
		const none = {...WORKED, board: {...WORKED.board, pull: null}};
		for (const field of ["number", "state", "head", "checks"]) {
			expect(fieldAt(none, `board.pull.${field}`)).toBeNull();
		}
		expect(preImage(none)).toContain("board.pull.checks=null");
	});

	it("digests nineteen and compares sixteen — the two sets are deliberately different sizes", () => {
		expect(DIGESTED_FIELDS).toHaveLength(19);
		expect(COMPARED_FIELDS).toHaveLength(16);
		expect(COMPARED_FIELDS.filter((field) => field.startsWith("git.tree."))).toEqual([]);
	});

	it("is twelve lowercase hex, and moves when a digested field moves", () => {
		expect(digestOf(WORKED)).toMatch(/^[0-9a-f]{12}$/);
		expect(digestOf({...WORKED, issue: 5022})).not.toBe(digestOf(WORKED));
	});
});

describe("compareGround", () => {
	const packed = comparableOf(GROUND);

	it("reports none when nothing moved", () => {
		const fields = compareGround(packed, packed);
		expect(driftState(fields)).toBe("none");
		expect(fields.filter((row) => row.state !== "same")).toEqual([]);
	});

	it("reports the moved field and nothing else", () => {
		const moved = compareGround(packed, {
			...packed,
			git: {...packed.git, head: "7ab3419e0c25d8f6041a2b3c4d5e6f7089abcdef"},
		});
		expect(driftState(moved)).toBe("moved");
		expect(moved.filter((row) => row.state !== "same").map((row) => row.field)).toEqual([
			"git.head",
		]);
	});

	it("reports rows 3-10 as moved with a null live value when the packed branch is gone", () => {
		const gone = compareGround(packed, {...packed, git: null});
		const git = gone.filter((row) => row.field.startsWith("git."));
		expect(git.every((row) => row.state === "moved" && row.live === null)).toBe(true);
		expect(
			gone.filter((row) => row.field.startsWith("board.")).every((r) => r.state === "same"),
		).toBe(true);
	});
});

describe("parseGround", () => {
	it("reads back what renderGround wrote", () => {
		const parsed = parseGround(JSON.stringify(GROUND));
		expect(parsed._tag).toBe("Ground");
		if (parsed._tag !== "Ground") return;
		expect(digestOf(parsed.value)).toBe(GROUND.groundDigest);
	});

	it("refuses a field off its shape rather than filling it in", () => {
		const broken = JSON.parse(JSON.stringify(GROUND)) as Record<string, unknown>;
		(broken.git as Record<string, unknown>).reachable = "maybe";
		expect(parseGround(JSON.stringify(broken))._tag).toBe("Unusable");
		expect(parseGround("not json")._tag).toBe("Unusable");
		expect(parseGround('{"issue":5021}')._tag).toBe("Unusable");
	});
});

describe("parseAheadBehind", () => {
	it("reads the left count as behind and the right as ahead", () => {
		expect(parseAheadBehind("3\t7")).toEqual({behindBy: 3, aheadBy: 7});
	});

	it("refuses anything that is not two counts, rather than answering zero", () => {
		expect(parseAheadBehind("")).toBeNull();
		expect(parseAheadBehind("3")).toBeNull();
	});
});

describe("the derivations", () => {
	it("counts tracked and untracked separately, and a failed status is never a clean tree", async () => {
		const dirty = await run(deriveTree, [
			[/status --porcelain/, okOut(" M worker/a.ts\n?? scratch.md\n")],
		]);
		expect(dirty).toMatchObject({value: {state: "dirty", trackedModified: 1, untracked: 1}});
		const failed = await run(deriveTree, [[/status --porcelain/, errOut("not a git repository")]]);
		expect(failed._tag).toBe("Failure");
	});

	it("reads an unset upstream as the FACT unknown, with both counts null", async () => {
		const core = await run(deriveGitCore({ref: null, base: "main"}), [
			[/rev-parse --abbrev-ref --symbolic-full-name/, errOut("no upstream configured")],
			[/rev-parse --abbrev-ref HEAD$/, okOut("umut/fanout-helper")],
			[/rev-parse --verify --quiet main\^/, okOut("11223344556677889900aabbccddeeff00112233")],
			[/rev-parse --verify --quiet/, okOut("4f1c8a2b9d3e5607182934abcdef5566778899aa")],
		]);
		expect(core).toMatchObject({
			value: {reachable: "unknown", upstream: null, aheadBy: null, behindBy: null},
		});
	});

	it("reads a head that is not an ancestor of its upstream as unpushed", async () => {
		const core = await run(deriveGitCore({ref: null, base: "main"}), [
			[/rev-parse --abbrev-ref --symbolic-full-name/, okOut("origin/umut/fanout-helper")],
			[/rev-parse --abbrev-ref HEAD$/, okOut("umut/fanout-helper")],
			[/rev-parse --verify --quiet main\^/, okOut("11223344556677889900aabbccddeeff00112233")],
			[/rev-parse --verify --quiet/, okOut("4f1c8a2b9d3e5607182934abcdef5566778899aa")],
			[/merge-base --is-ancestor/, errOut("")],
			[/rev-list --left-right --count/, okOut("0\t2")],
		]);
		expect(core).toMatchObject({value: {reachable: "unpushed", aheadBy: 2}});
	});

	it("reports checks as none only over a rollup it read, never over one it could not", async () => {
		expect(
			await run(deriveChecks("o/r", "abc"), [
				[/check-runs/, okOut('{"total_count":0,"check_runs":[]}')],
			]),
		).toMatchObject({value: "none"});
		expect(
			await run(deriveChecks("o/r", "abc"), [[/check-runs/, errOut("gh: Bad gateway (HTTP 502)")]]),
		).toMatchObject({_tag: "Failure"});
	});

	it("calls a branch gone only once the repository itself reads, never on a broken checkout", async () => {
		expect(
			await run(resolveBranch("gone/branch"), [
				[/rev-parse --verify --quiet/, errOut("")],
				[/rev-parse --is-inside-work-tree/, okOut("true")],
			]),
		).toBe("gone");
		expect(
			await run(resolveBranch("gone/branch"), [
				[/rev-parse --verify --quiet/, errOut("")],
				[/rev-parse --is-inside-work-tree/, errOut("not a git repository")],
			]),
		).toBe("unknown");
	});

	it("derives the whole ground, and refuses rather than reporting a tree it could not read", async () => {
		const derived = await run(
			deriveGround({
				repo: "o/r",
				issue: 5021,
				ref: null,
				base: "main",
				board: {state: "open", labels: ["type:chore", "p2"]},
				now: () => new Date("2026-08-09T18:36:48.000Z"),
			}),
			groundScript(),
		);
		expect(derived._tag).toBe("Ground");
		if (derived._tag !== "Ground") return;
		expect(derived.value.board.issue.labels).toEqual(["p2", "type:chore"]);
		expect(derived.value.groundDigest).toMatch(/^[0-9a-f]{12}$/);

		const blind = await run(
			deriveGround({
				repo: "o/r",
				issue: 5021,
				ref: null,
				base: "main",
				board: {state: "open", labels: []},
				now: () => new Date("2026-08-09T18:36:48.000Z"),
			}),
			[[/status --porcelain/, errOut("not a git repository")], ...groundScript()],
		);
		expect(blind).toMatchObject({_tag: "Failed", failure: {kind: "git"}});
	});
});
