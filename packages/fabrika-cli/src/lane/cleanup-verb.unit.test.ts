/** `lane cleanup` — a lane's recorded worktrees go, and every one that holds work stays and is named. */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeSeams, okOut, once, type Scripted} from "../fakes.test-support.ts";
import {type Attempt, fail, ok} from "../io/git.ts";
import {type PullRead, runCleanup} from "./cleanup-verb.ts";
import {APPEND_UNKNOWN, LANE_UNREADABLE, MALFORMED_RECORD, TREES_KEPT} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";

const ROOT = ".fabrika/lanes";
const LANE = "42";
const DIR = `${ROOT}/${LANE}`;
const RECORDS = `${DIR}/worktrees.jsonl`;
const MAIN = "/checkout/repo";
const BUILDER = `${MAIN}/.claude/worktrees/agent-builder`;
const REVIEWER = `${MAIN}/.claude/worktrees/agent-reviewer`;
const SHIPPER = `${MAIN}/.claude/worktrees/agent-shipper`;
const HEAD = "a".repeat(40);
const PULL = "https://forge.test/o/r/pull/77";
const TOKEN = "build:session-a:11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const at = (minute: number): string => new Date(Date.UTC(2026, 9, 3, 6, minute)).toISOString();

const handed = (worktree: string, minute = 0): string =>
	`${JSON.stringify({kind: "handed", worktree, task: "issue", at: at(minute)})}\n`;

const LIST = /^git worktree list --porcelain$/;
const REMOVE = /^git worktree remove /;
const status = (tree: string) => new RegExp(`^git -C ${tree} status --porcelain$`);
const ahead = (tree: string) =>
	new RegExp(`^git -C ${tree} rev-list --count HEAD --not --remotes$`);
const head = (tree: string) => new RegExp(`^git -C ${tree} rev-parse HEAD$`);

const listing = (...linked: ReadonlyArray<string>) =>
	okOut(
		[MAIN, ...linked]
			.map(
				(path) =>
					`worktree ${path}\nHEAD aaaa111\n${path === MAIN ? "branch refs/heads/main" : "detached"}\n`,
			)
			.join("\n"),
	);

/** A tree with nothing uncommitted and every commit on a remote ref. */
const clean = (tree: string): ReadonlyArray<Scripted> => [
	[status(tree), okOut("")],
	[ahead(tree), okOut("0\n")],
];

interface Scene {
	readonly records?: string;
	readonly log?: string;
	readonly inFlight?: string;
	readonly unreadable?: ReadonlyArray<string>;
	readonly caller?: Attempt<string>;
	readonly pull?: PullRead;
}

const run = (script: ReadonlyArray<Scripted>, scene: Scene = {}) => {
	const shell = fakeSeams(script);
	const fs = fakeFs({
		files: {
			[`${DIR}/workflow.json`]: coderTemplateText(),
			[`${DIR}/events.jsonl`]: scene.log ?? "",
			[RECORDS]: scene.records ?? handed(BUILDER) + handed(REVIEWER, 1),
			...(scene.inFlight === undefined ? {} : {[`${DIR}/in-flight.jsonl`]: scene.inFlight}),
		},
		unreadable: scene.unreadable ?? [],
		directories: [ROOT, DIR],
	});
	return Effect.runPromise(
		Effect.provide(
			runCleanup({
				root: ROOT,
				lane: LANE,
				caller: scene.caller ?? ok(SHIPPER),
				pull: () => Effect.succeed(scene.pull ?? {_tag: "Unmerged"}),
			}),
			Layer.merge(shell.layer, fs.layer),
		),
	).then((outcome) => ({outcome, calls: shell.calls, written: fs.written}));
};

const removals = (calls: ReadonlyArray<string>) => calls.filter((line) => REMOVE.test(line));

describe("runCleanup", () => {
	it("removes every clean recorded tree with a plain git worktree remove and retires its record", async () => {
		const {outcome, calls, written} = await run([
			[once(LIST), listing(BUILDER, REVIEWER)],
			[LIST, listing()],
			...clean(BUILDER),
			...clean(REVIEWER),
			[REMOVE, okOut("")],
		]);

		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "cleaned",
			lane: LANE,
			removed: [BUILDER, REVIEWER],
			gone: [],
			left: [],
		});
		expect(removals(calls)).toEqual([
			`git worktree remove ${BUILDER}`,
			`git worktree remove ${REVIEWER}`,
		]);
		expect(calls.some((line) => line.includes("--force"))).toBe(false);
		const lines = (written.get(RECORDS) ?? "")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines.slice(2)).toMatchObject([
			{kind: "removed", worktree: BUILDER},
			{kind: "removed", worktree: REVIEWER},
		]);
	});

	it("keeps a tree with uncommitted paths, names it, and still removes the clean one beside it", async () => {
		const {outcome, calls} = await run([
			[once(LIST), listing(BUILDER, REVIEWER)],
			[LIST, listing(BUILDER)],
			[status(BUILDER), okOut(" M src/a.ts\n?? notes.md\n")],
			...clean(REVIEWER),
			[REMOVE, okOut("")],
		]);

		expect(outcome.code).toBe(TREES_KEPT);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr).toContain(
			`fabrika lane cleanup: kept ${BUILDER} — uncommitted: 2 uncommitted paths`,
		);
		expect(removals(calls)).toEqual([`git worktree remove ${REVIEWER}`]);
	});

	it("keeps a tree whose commits are on no remote ref and in no merged pull request", async () => {
		const {outcome, calls} = await run(
			[
				[LIST, listing(BUILDER)],
				[status(BUILDER), okOut("")],
				[ahead(BUILDER), okOut("3\n")],
				[head(BUILDER), okOut(`${HEAD}\n`)],
			],
			{
				records: handed(BUILDER),
				log: `${JSON.stringify({task: "issue", event: "ISSUE.WIP", at: at(0), pr: PULL})}\n`,
				pull: {_tag: "Unmerged"},
			},
		);

		expect(outcome.code).toBe(TREES_KEPT);
		expect(outcome.stderr).toContain(
			`fabrika lane cleanup: kept ${BUILDER} — unpublished: 3 commits on no remote ref — #77 is not merged`,
		);
		expect(removals(calls)).toEqual([]);
	});

	it("removes a tree whose local-only commits the lane's merged pull request carries", async () => {
		const {outcome, calls} = await run(
			[
				[once(LIST), listing(BUILDER)],
				[LIST, listing()],
				[status(BUILDER), okOut("")],
				[ahead(BUILDER), okOut("3\n")],
				[head(BUILDER), okOut(`${HEAD}\n`)],
				[REMOVE, okOut("")],
			],
			{
				records: handed(BUILDER),
				log: `${JSON.stringify({task: "issue", event: "ISSUE.WIP", at: at(0), pr: PULL})}\n`,
				pull: {_tag: "Merged", headSha: HEAD},
			},
		);

		expect(outcome.code).toBe(0);
		expect(removals(calls)).toEqual([`git worktree remove ${BUILDER}`]);
	});

	it("never removes the tree it runs in or the main working tree, and reads neither", async () => {
		const {outcome, calls} = await run([[LIST, listing(BUILDER, SHIPPER)], ...clean(BUILDER)], {
			records: handed(SHIPPER) + handed(MAIN, 1),
		});

		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).left).toEqual([
			{worktree: SHIPPER, reason: "caller"},
			{worktree: MAIN, reason: "main-working-tree"},
		]);
		expect(outcome.stderr[0]).toContain(`left ${SHIPPER} — this verb runs in it`);
		expect(calls).toEqual(["git worktree list --porcelain"]);
	});

	it("keeps the tree a builder's standing in-flight record still names", async () => {
		const {outcome, calls} = await run([[LIST, listing(BUILDER)]], {
			records: handed(BUILDER),
			inFlight: `${JSON.stringify({kind: "working", task: "issue", token: TOKEN, worktree: BUILDER, at: at(1)})}\n`,
		});

		expect(outcome.code).toBe(TREES_KEPT);
		expect(outcome.stderr[0]).toContain(`kept ${BUILDER} — in-flight`);
		expect(removals(calls)).toEqual([]);
	});

	it("keeps and names a tree git declined to remove", async () => {
		const {outcome} = await run(
			[[LIST, listing(BUILDER)], ...clean(BUILDER), [REMOVE, errOut("fatal: process is using it")]],
			{records: handed(BUILDER)},
		);

		expect(outcome.code).toBe(TREES_KEPT);
		expect(outcome.stderr[0]).toBe(
			`fabrika lane cleanup: kept ${BUILDER} — remove-refused: fatal: process is using it`,
		);
	});

	it("retires a recorded tree that is no longer a working tree, and one a later record removed stays out", async () => {
		const {outcome, calls, written} = await run([[LIST, listing(REVIEWER)]], {
			records:
				handed(BUILDER) +
				handed(REVIEWER, 1) +
				`${JSON.stringify({kind: "removed", worktree: REVIEWER, at: at(2)})}\n`,
		});

		expect(JSON.parse(outcome.stdout)).toMatchObject({removed: [], gone: [BUILDER]});
		expect(removals(calls)).toEqual([]);
		expect(written.get(RECORDS)?.trim().split("\n")).toHaveLength(4);
	});

	it("removes nothing when a record or a tree read it depends on does not answer", async () => {
		const cases: ReadonlyArray<{scene: Scene; script: ReadonlyArray<Scripted>; code: number}> = [
			{scene: {unreadable: [RECORDS]}, script: [], code: LANE_UNREADABLE},
			{scene: {records: "{not json\n"}, script: [], code: MALFORMED_RECORD},
			{
				scene: {unreadable: [`${DIR}/in-flight.jsonl`], inFlight: ""},
				script: [],
				code: LANE_UNREADABLE,
			},
			{scene: {caller: fail("not a repository")}, script: [], code: LANE_UNREADABLE},
			{scene: {}, script: [[LIST, errOut("git broke")]], code: LANE_UNREADABLE},
		];
		for (const {scene, script, code} of cases) {
			const {outcome, calls, written} = await run(script, scene);
			expect(outcome.code).toBe(code);
			expect(outcome.stdout).toBe("");
			expect(removals(calls)).toEqual([]);
			expect(written.has(RECORDS)).toBe(false);
		}
	});

	it("calls the outcome UNKNOWN when the trees cannot be re-read after a removal ran", async () => {
		const {outcome} = await run(
			[
				[once(LIST), listing(BUILDER)],
				[LIST, errOut("git broke")],
				...clean(BUILDER),
				[REMOVE, okOut("")],
			],
			{records: handed(BUILDER)},
		);

		expect(outcome.code).toBe(APPEND_UNKNOWN);
		expect(outcome.stderr).toContain(`fabrika lane cleanup: removal attempted: ${BUILDER}`);
	});
});
