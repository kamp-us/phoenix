/** The in-flight record — its two writers, and what `lane status` names off it. */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {fail, ok} from "../io/git.ts";
import {FACT_REFUSED, LANE_UNREADABLE, NO_SHELL} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {runDispatched, runWorking} from "./in-flight-verb.ts";
import {runStatus} from "./status-verb.ts";

const ROOT = ".fabrika/lanes";
const LANE = "42";
const WORKFLOW = `${ROOT}/${LANE}/workflow.json`;
const LOG = `${ROOT}/${LANE}/events.jsonl`;
const RECORDS = `${ROOT}/${LANE}/in-flight.jsonl`;

const TOKEN_A = "build:session-a:11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TREE_A = "/work/trees/agent-a";
const TOKEN_B = "build:session-a:22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TREE_B = "/work/trees/agent-b";

const at = (minute: number): string => new Date(Date.UTC(2026, 8, 29, 6, minute)).toISOString();

const event = (name: string, minute: number, extra: Record<string, unknown> = {}): string =>
	`${JSON.stringify({task: "issue", event: `ISSUE.${name}`, at: at(minute), ...extra})}\n`;

const dispatch = (minute: number): string =>
	`${JSON.stringify({kind: "dispatched", task: "issue", state: "build", at: at(minute)})}\n`;

const working = (minute: number, token: string, worktree: string): string =>
	`${JSON.stringify({kind: "working", task: "issue", token, worktree, at: at(minute)})}\n`;

const laneFs = (log: string, records?: string) =>
	fakeFs({
		files: {
			[WORKFLOW]: coderTemplateText(),
			[LOG]: log,
			...(records === undefined ? {} : {[RECORDS]: records}),
		},
		dirs: {[ROOT]: [LANE]},
		directories: [ROOT],
	});

const status = async (log: string, records?: string) => {
	const out = await Effect.runPromise(
		Effect.provide(runStatus({root: ROOT, lane: LANE}), laneFs(log, records).layer),
	);
	expect(out.code).toBe(0);
	return {out, answer: JSON.parse(out.stdout) as Record<string, unknown>};
};

describe("lane status names the shell in flight", () => {
	it("shows a dispatch and the builder's seat beside it", async () => {
		const {answer} = await status(event("WIP", 0), dispatch(1) + working(2, TOKEN_A, TREE_A));

		expect(answer.inFlight).toEqual({
			issue: {
				dispatched: {state: "build", shell: "builder", at: at(1)},
				working: {token: TOKEN_A, worktree: TREE_A, at: at(2)},
			},
		});
	});

	it("names a dispatch no builder has claimed under yet with a null seat", async () => {
		const {answer} = await status(event("WIP", 0), dispatch(1));

		expect(answer.inFlight).toEqual({
			issue: {dispatched: {state: "build", shell: "builder", at: at(1)}, working: null},
		});
	});

	it("drops the record once a terminal, a lap or a park moves the task", async () => {
		const facts = dispatch(1) + working(2, TOKEN_A, TREE_A);
		for (const moved of [
			event("DONE", 3, {pr: "https://forge.test/o/r/pull/12"}),
			event("LAP", 3, {cause: "spawn-dead"}),
			event("BLOCKED", 3, {cause: "spawn-dead"}),
		]) {
			const {answer} = await status(event("WIP", 0) + moved, facts);
			expect(answer).not.toHaveProperty("inFlight");
		}
	});

	it("keeps the record across a clearance, which moves no task", async () => {
		const {answer} = await status(
			event("WIP", 0) + event("CLEARED", 3, {round: 1}),
			dispatch(1) + working(2, TOKEN_A, TREE_A),
		);

		expect(answer.inFlight).toMatchObject({issue: {working: {token: TOKEN_A}}});
	});

	it("after a SHELL-DEAD lap and a re-dispatch, names the second shell and not the first", async () => {
		const log = event("WIP", 0) + event("LAP", 3, {cause: "spawn-dead"});
		const first = dispatch(1) + working(2, TOKEN_A, TREE_A);

		const respawned = await status(log, first + dispatch(4));
		expect(respawned.answer.inFlight).toEqual({
			issue: {dispatched: {state: "build", shell: "builder", at: at(4)}, working: null},
		});

		const seated = await status(log, first + dispatch(4) + working(5, TOKEN_B, TREE_B));
		expect(seated.answer.inFlight).toEqual({
			issue: {
				dispatched: {state: "build", shell: "builder", at: at(4)},
				working: {token: TOKEN_B, worktree: TREE_B, at: at(5)},
			},
		});
		expect(seated.out.stdout).not.toContain(TOKEN_A);
		expect(seated.out.stdout).not.toContain(TREE_A);
	});

	it("drops a seat recorded before the standing dispatch — it was the replaced shell's", async () => {
		const {answer} = await status(
			event("WIP", 0),
			dispatch(1) + working(2, TOKEN_A, TREE_A) + dispatch(3),
		);

		expect(answer.inFlight).toEqual({
			issue: {dispatched: {state: "build", shell: "builder", at: at(3)}, working: null},
		});
	});

	it("changes no machine fold: stateValue and context match the same ledger without the record", async () => {
		const log = event("WIP", 0) + event("LAP", 3, {cause: "spawn-dead"});
		const without = await status(log);
		const withRecord = await status(
			log,
			dispatch(1) + working(2, TOKEN_A, TREE_A) + dispatch(4) + working(5, TOKEN_B, TREE_B),
		);

		expect(withRecord.answer.stateValue).toEqual(without.answer.stateValue);
		expect(withRecord.answer.context).toEqual(without.answer.context);
		const {inFlight, ...rest} = withRecord.answer;
		expect(inFlight).toBeDefined();
		expect(rest).toEqual(without.answer);
	});

	it("still answers the fold when the record does not read, and says the record is UNKNOWN", async () => {
		const {out, answer} = await status(event("WIP", 0), "not json\n");

		expect(answer.stateValue).toEqual({pipeline: {issue: "build"}});
		expect(answer).not.toHaveProperty("inFlight");
		expect(answer.inFlightUnread).toContain("not the shape");
		expect(out.stderr.join("\n")).toContain("UNKNOWN");
	});
});

describe("lane dispatched", () => {
	const run = (fs: ReturnType<typeof laneFs>, task: string | null = null) =>
		Effect.runPromise(Effect.provide(runDispatched({root: ROOT, lane: LANE, task}), fs.layer));

	it("records the state and the shell it routes to, and never an event", async () => {
		const fs = laneFs(event("WIP", 0));

		const out = await run(fs);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "dispatched",
			lane: LANE,
			task: "issue",
			state: "build",
			shell: "builder",
		});
		expect(JSON.parse(fs.written.get(RECORDS) ?? "")).toMatchObject({
			kind: "dispatched",
			task: "issue",
			state: "build",
		});
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("refuses a state that routes to no shell, writing nothing", async () => {
		const fs = laneFs("");

		const out = await run(fs);

		expect(out.code).toBe(NO_SHELL);
		expect([...fs.written.keys()].filter((path) => path === RECORDS || path === LOG)).toEqual([]);
	});
});

describe("lane working", () => {
	const run = (
		fs: ReturnType<typeof laneFs>,
		token: string,
		worktree: ReturnType<typeof ok<string>> | ReturnType<typeof fail> = ok(TREE_A),
	) =>
		Effect.runPromise(
			Effect.provide(runWorking({root: ROOT, lane: LANE, task: null, token, worktree}), fs.layer),
		);

	it("records the claim token and the absolute tree on the task the builder serves", async () => {
		const fs = laneFs(event("WIP", 0));

		const out = await run(fs, TOKEN_A);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "working",
			task: "issue",
			token: TOKEN_A,
			worktree: TREE_A,
		});
		expect(JSON.parse(fs.written.get(RECORDS) ?? "")).toMatchObject({
			kind: "working",
			token: TOKEN_A,
			worktree: TREE_A,
		});
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("refuses what is not a build claim, a tree it cannot place, and a task no builder serves", async () => {
		const cases = [
			{log: event("WIP", 0), token: "lane:session-a:1111", tree: ok(TREE_A), code: FACT_REFUSED},
			{log: event("WIP", 0), token: TOKEN_A, tree: ok("work/tree"), code: FACT_REFUSED},
			{log: event("WIP", 0), token: TOKEN_A, tree: fail("not a repository"), code: LANE_UNREADABLE},
			{
				log: event("WIP", 0) + event("DONE", 1, {pr: "https://forge.test/o/r/pull/12"}),
				token: TOKEN_A,
				tree: ok(TREE_A),
				code: NO_SHELL,
			},
		];
		for (const {log, token, tree, code} of cases) {
			const fs = laneFs(log);
			const out = await run(fs, token, tree);
			expect(out.code).toBe(code);
			expect([...fs.written.keys()].filter((path) => path === RECORDS || path === LOG)).toEqual([]);
		}
	});
});
