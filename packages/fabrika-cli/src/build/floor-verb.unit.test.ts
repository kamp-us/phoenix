/** `build floor` — who holds the primary checkout's uncommitted changes, read and never written. */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeSeams, okOut, type Scripted} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	comments,
	GATEWAY,
	GH_TOKEN_ENV,
	LANE_UUID,
	marker,
	NONCE,
	SIBLING_UUID,
	served,
} from "./fixtures.test-support.ts";
import {
	byStrength,
	type LaneTip,
	type Owner,
	pairPaths,
	parseGraph,
	parseStatus,
	parseTips,
	parseTouches,
} from "./floor.ts";
import {runFloor} from "./floor-verb.ts";

const LANE = `build/4312-editor-focus-loss-${NONCE}`;
const OTHER = "build/4400-toolbar-rework-7bab0955";
const TIP = "a".repeat(40);
const OTHER_TIP = "b".repeat(40);
const SHARED = "c".repeat(40);

const WORKTREES = /^git worktree list --porcelain$/;
const STATUS =
	/^git -C \/repo --no-optional-locks status --porcelain=v1 -z -- \. :\(exclude\)\.pi\/subagents$/;
const TRUNK = /^git symbolic-ref --short refs\/remotes\/origin\/HEAD$/;
const TIPS = /^git -C \/repo --no-optional-locks for-each-ref /;
const GRAPH = /^git -C \/repo --no-optional-locks log --format=%H %P /;
const TOUCHES = /^git -C \/repo --no-optional-locks --literal-pathspecs log /;
const COMMENTS = /GET .*\/repos\/o\/r\/issues\/4312\/comments/;
const PERM = /GET .*\/repos\/o\/r\/collaborators\/agent\/permission/;

const primaryOn = (branch: string | null) =>
	okOut(
		[
			"worktree /repo",
			`HEAD ${"d".repeat(40)}`,
			branch === null ? "detached" : `branch refs/heads/${branch}`,
			"",
			"worktree /repo/.claude/worktrees/agent-1",
			`HEAD ${"e".repeat(40)}`,
			"detached",
			"",
		].join("\n"),
	);

const LANE_TIPS = okOut(`${TIP} ${LANE}\n${OTHER_TIP} ${OTHER}\n${"f".repeat(40)} main\n`);
const LANE_GRAPH = okOut(`${TIP} ${SHARED}\n${OTHER_TIP} ${SHARED}\n${SHARED} ${"0".repeat(40)}\n`);
const touching = (...rows: ReadonlyArray<readonly [string, ReadonlyArray<string>]>) =>
	okOut(
		rows.map(([sha, paths]) => `\x01${sha}\0\n${paths.map((p) => `${p}\0`).join("")}`).join(""),
	);

const ENV = {...GH_TOKEN_ENV, CLAUDE_PIPELINE_REPO: "o/r"};

const dirtyScript = (status: string, touches = touching()): ReadonlyArray<Scripted> => [
	[WORKTREES, primaryOn("main")],
	[STATUS, okOut(status)],
	[TRUNK, okOut("origin/main\n")],
	[TIPS, LANE_TIPS],
	[GRAPH, LANE_GRAPH],
	[TOUCHES, touches],
];

const run = (script: ReadonlyArray<Scripted>) => {
	const seams = fakeSeams(script);
	return Effect.runPromise(
		Effect.provide(runFloor({repo: null, env: ENV}), seams.layer).pipe(
			Effect.map((out) => ({out, seams})),
		),
	);
};

/** Nothing this verb runs may write: git only through read verbs, the board only through GETs. */
const expectNoWrites = (seams: {calls: ReadonlyArray<string>; requests: ReadonlyArray<string>}) => {
	for (const call of seams.calls) {
		expect(call).toMatch(/^git (worktree list|symbolic-ref|-C \/repo --no-optional-locks )/);
		expect(call).not.toMatch(
			/\b(stash|commit|checkout|switch|branch|update-ref|add|reset|worktree (add|remove|prune))\b/,
		);
	}
	for (const request of seams.requests) expect(request).toMatch(/^GET /);
};

describe("build floor", () => {
	it("answers a clean primary checkout with a positive free statement on 0", async () => {
		const {out, seams} = await run([
			[WORKTREES, primaryOn("main")],
			[STATUS, okOut("")],
		]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "free",
			primary: "/repo",
			head: "main",
			paths: [],
		});
		expect(out.stderr.join("\n")).toContain("the floor is free");
		expectNoWrites(seams);
	});

	it("names the lane branch whose own commits touch a dirty path, with its standing claim", async () => {
		const {out, seams} = await run([
			...dirtyScript(" M src/editor.ts\0", touching([TIP, ["src/editor.ts"]])),
			[COMMENTS, comments({id: 9001, body: marker("s-9f2e", LANE_UUID)})],
			[PERM, served({permission: "write"})],
		]);

		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer.answer).toBe("held");
		expect(answer.paths).toEqual([
			{
				path: "src/editor.ts",
				status: " M",
				origin: null,
				owners: [
					{
						branch: LANE,
						number: 4312,
						kind: "issue",
						evidence: ["touches-path"],
						claim: "standing",
						holder: `build:s-9f2e:${LANE_UUID}`,
					},
				],
			},
		]);
		expect(out.stderr.join("\n")).toContain(`strongest candidate ${LANE}`);
		expectNoWrites(seams);
	});

	it("names no owner for a path no claim and no lane branch reaches, and reads no claim", async () => {
		const {out, seams} = await run(dirtyScript("?? notes/scratch.md\0"));

		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer.paths).toEqual([
			{path: "notes/scratch.md", status: "??", origin: null, owners: []},
		]);
		expect(out.stderr.join("\n")).toContain(
			"notes/scratch.md — no claim and no lane branch reaches it; no owner is named.",
		);
		expect(seams.requests).toEqual([]);
		expectNoWrites(seams);
	});

	it("refuses an unreadable claim surface on 11 and prints no guessed name", async () => {
		const {out, seams} = await run([
			...dirtyScript(" M src/editor.ts\0", touching([TIP, ["src/editor.ts"]])),
			[COMMENTS, GATEWAY],
		]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("cannot read the claim markers on #4312");
		expect(out.stderr.at(-1)).toContain("UNKNOWN, never a guessed name");
		expect(out.stderr.join("\n")).not.toContain(LANE);
		expectNoWrites(seams);
	});

	it("refuses an unreadable status on 11 rather than calling the floor free", async () => {
		const {out, seams} = await run([
			[WORKTREES, primaryOn("main")],
			[STATUS, errOut("fatal: index file corrupt")],
		]);

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expectNoWrites(seams);
	});

	it("reads the checked-out lane as a candidate and ranks it ahead of a mere touch", async () => {
		const {out} = await run([
			[WORKTREES, primaryOn(OTHER)],
			[STATUS, okOut(" M src/editor.ts\0")],
			[TRUNK, okOut("origin/main\n")],
			[TIPS, LANE_TIPS],
			[GRAPH, LANE_GRAPH],
			[TOUCHES, touching([TIP, ["src/editor.ts"]])],
			[COMMENTS, comments({id: 9001, body: marker("s-9f2e", LANE_UUID)})],
			[
				/GET .*\/repos\/o\/r\/issues\/4400\/comments/,
				comments({id: 9002, body: marker("s-other", SIBLING_UUID)}),
			],
			[PERM, served({permission: "write"})],
		]);

		expect(out.code).toBe(0);
		const owners = JSON.parse(out.stdout).paths[0].owners;
		expect(owners.map((owner: Owner) => [owner.branch, owner.evidence, owner.claim])).toEqual([
			[OTHER, ["checked-out"], "standing"],
			[LANE, ["touches-path"], "standing"],
		]);
	});
});

describe("floor decision core", () => {
	it("parses porcelain -z, keeping a rename's source and a path with a space intact", () => {
		expect(parseStatus("R  new name.ts\0old name.ts\0?? dir/\0 M a.ts\0")).toEqual([
			{status: "R ", path: "new name.ts", origin: "old name.ts"},
			{status: "??", path: "dir/", origin: null},
			{status: " M", path: "a.ts", origin: null},
		]);
	});

	it("pins a touch only on the branch that alone carries the commit", () => {
		const tips: ReadonlyArray<LaneTip> = parseTips(`${TIP} ${LANE}\n${OTHER_TIP} ${OTHER}\n`);
		const [pairing] = pairPaths({
			dirty: parseStatus(" M shared.ts\0"),
			head: null,
			tips,
			graph: parseGraph(`${TIP} ${SHARED}\n${OTHER_TIP} ${SHARED}\n${SHARED}\n`),
			touches: parseTouches(`\x01${SHARED}\0\nshared.ts\0`),
		});
		expect(pairing?.candidates).toEqual([]);
	});

	it("matches a file under an untracked directory git collapsed", () => {
		const [pairing] = pairPaths({
			dirty: parseStatus("?? output/\0"),
			head: null,
			tips: parseTips(`${TIP} ${LANE}\n`),
			graph: parseGraph(`${TIP}\n`),
			touches: parseTouches(`\x01${TIP}\0\noutput/report.json\0`),
		});
		expect(pairing?.candidates.map((candidate) => candidate.branch)).toEqual([LANE]);
	});

	it("ranks by evidence first, then by how live the claim is", () => {
		const owner = (branch: string, evidence: Owner["evidence"], claim: Owner["claim"]): Owner => ({
			branch,
			number: 1,
			kind: "issue",
			evidence,
			claim,
			holder: null,
		});
		const ranked = [
			owner("a", ["touches-path"], "unclaimed"),
			owner("b", ["touches-path"], "standing"),
			owner("c", ["checked-out", "touches-path"], "unclaimed"),
		].sort(byStrength);
		expect(ranked.map((row) => row.branch)).toEqual(["c", "b", "a"]);
	});
});
