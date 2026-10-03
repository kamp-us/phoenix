/** `lane worktree` — every shell's tree lands on the lane's record, once, and the main tree never does. */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {fail, ok} from "../io/git.ts";
import {LANE_UNREADABLE, MALFORMED_RECORD, TASK_UNKNOWN} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {runWorktree, type WorktreeOptions} from "./worktree-verb.ts";
import {handedTrees, parseWorktrees} from "./worktrees.ts";

const ROOT = ".fabrika/lanes";
const LANE = "42";
const DIR = `${ROOT}/${LANE}`;
const RECORDS = `${DIR}/worktrees.jsonl`;
const TREE = "/checkout/repo/.claude/worktrees/agent-reviewer";

const laneFs = (records?: string) =>
	fakeFs({
		files: {
			[`${DIR}/workflow.json`]: coderTemplateText(),
			...(records === undefined ? {} : {[RECORDS]: records}),
		},
		directories: [ROOT, DIR],
	});

const run = (fs: ReturnType<typeof laneFs>, overrides: Partial<WorktreeOptions> = {}) =>
	Effect.runPromise(
		Effect.provide(
			runWorktree({
				root: ROOT,
				lane: LANE,
				task: "issue",
				worktree: ok(TREE),
				linked: ok(true),
				...overrides,
			}),
			fs.layer,
		),
	);

const held = (fs: ReturnType<typeof laneFs>) => {
	const parsed = parseWorktrees(fs.written.get(RECORDS) ?? "");
	return parsed._tag === "Parsed" ? handedTrees(parsed.records) : null;
};

describe("runWorktree", () => {
	it("records the tree with its task, and a second run adds no second line", async () => {
		const fs = laneFs();

		const first = await run(fs);
		const second = await run(fs);

		expect(JSON.parse(first.stdout)).toMatchObject({
			answer: "handed",
			worktree: TREE,
			recorded: true,
		});
		expect(JSON.parse(second.stdout)).toMatchObject({answer: "handed", recorded: false});
		expect(held(fs)).toEqual([{worktree: TREE, task: "issue"}]);
		expect(fs.written.get(RECORDS)?.trim().split("\n")).toHaveLength(1);
	});

	it("records a driver's tree, which serves no task", async () => {
		const fs = laneFs();

		await run(fs, {task: null});

		expect(held(fs)).toEqual([{worktree: TREE, task: null}]);
	});

	it("answers the main working tree without recording it", async () => {
		const fs = laneFs();

		const out = await run(fs, {linked: ok(false)});

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "main", recorded: false});
		expect(fs.written.has(RECORDS)).toBe(false);
	});

	it("refuses an unread tree, a task the machine lacks and a record that is not the shape", async () => {
		const cases = [
			{fs: laneFs(), overrides: {worktree: fail("not a repository")}, code: LANE_UNREADABLE},
			{fs: laneFs(), overrides: {linked: fail("git broke")}, code: LANE_UNREADABLE},
			{fs: laneFs(), overrides: {task: "nope"}, code: TASK_UNKNOWN},
			{fs: laneFs("{not json\n"), overrides: {}, code: MALFORMED_RECORD},
		];
		for (const {fs, overrides, code} of cases) {
			const out = await run(fs, overrides);
			expect(out.code).toBe(code);
			expect(fs.written.has(RECORDS)).toBe(false);
		}
	});
});

describe("handedTrees", () => {
	it("holds a tree while its latest record is handed, so a re-handed path comes back", () => {
		const line = (kind: string, worktree: string, minute: number) =>
			JSON.stringify({
				kind,
				worktree,
				...(kind === "handed" ? {task: null} : {}),
				at: new Date(Date.UTC(2026, 9, 3, 6, minute)).toISOString(),
			});
		const parsed = parseWorktrees(
			[
				line("handed", "/t/a", 0),
				line("handed", "/t/b", 1),
				line("removed", "/t/a", 2),
				line("removed", "/t/b", 3),
				line("handed", "/t/b", 4),
			].join("\n"),
		);

		expect(parsed._tag === "Parsed" && handedTrees(parsed.records)).toEqual([
			{worktree: "/t/b", task: null},
		]);
	});

	it("reads a relative path or an unknown kind as a defect, never a skipped line", () => {
		const parsed = parseWorktrees(
			`${JSON.stringify({kind: "handed", worktree: "rel/tree", task: null, at: "2026-10-03"})}\n` +
				`${JSON.stringify({kind: "lent", worktree: "/t/a", at: "2026-10-03"})}\n`,
		);

		expect(parsed).toMatchObject({_tag: "Malformed"});
		expect(parsed._tag === "Malformed" && parsed.defects).toHaveLength(2);
	});
});
