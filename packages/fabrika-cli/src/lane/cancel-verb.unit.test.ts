/**
 * `lane cancel` on lane 5983's shape: parked at `blocked`, its issue closed not-planned, and no
 * legal event to end it. The lane that got hand-deleted is the lane this file drives to a recorded
 * terminal — and every read that must NOT reach one.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {Claimant} from "../build/claim.ts";
import {fakeFs} from "../fakes.test-support.ts";
import {type ClaimsReader, type ClosureReader, runCancel} from "./cancel-verb.ts";
import {
	CLAIM_NOT_MINE,
	CLOSURE_LANDED,
	EVENT_REFUSED,
	ISSUE_LIVE,
	ISSUE_UNRESOLVED,
	LANE_UNREADABLE,
	TASK_UNKNOWN,
} from "./codes.ts";
import {seatsIn} from "./concurrency.ts";
import {choreTemplateText, coderTemplateText} from "./fixtures.test-support.ts";
import {runStale} from "./stale-verb.ts";
import {runStatus} from "./status-verb.ts";
import {DEFAULT_CHORES_ROOT} from "./store.ts";

const ROOT = ".fabrika/lanes";
const DIR = `${ROOT}/5983`;
const WORKFLOW = `${DIR}/workflow.json`;
const LOG = `${DIR}/events.jsonl`;

const line = (event: string): string =>
	`${JSON.stringify({task: "issue", event: `ISSUE.${event}`, at: "2026-08-29T00:00:00.000Z"})}\n`;

/** Lane 5983's own shape: driven into `build`, then parked. */
const PARKED = `${line("WIP")}${line("BLOCKED")}`;

const closes =
	(state: "open" | "closed", reason: string | null): ClosureReader<never> =>
	() =>
		Effect.succeed({_tag: "Read", state, reason});

const unreadableBoard: ClosureReader<never> = () =>
	Effect.succeed({_tag: "Unknown", reason: "the API answered 503"});

const claimant = (token: string): Claimant => ({
	token,
	session: "a-driver-session",
	author: "usirin",
	commentId: 1,
	createdAt: "2026-08-29T00:00:00.000Z",
	authorized: true,
});

const unclaimed: ClaimsReader<never> = () =>
	Effect.succeed({_tag: "Read", claimants: [], adopts: [], holder: null});

const claimedBy =
	(token: string): ClaimsReader<never> =>
	() =>
		Effect.succeed({_tag: "Read", claimants: [], adopts: [], holder: claimant(token)});

const unreadableClaims: ClaimsReader<never> = () =>
	Effect.succeed({_tag: "Unknown", reason: "the comment page did not load"});

const laneFs = (log = PARKED) =>
	fakeFs({
		files: {[WORKFLOW]: coderTemplateText(), [LOG]: log},
		dirs: {[ROOT]: ["5983"]},
		directories: [ROOT],
	});

const cancel = (
	fs: ReturnType<typeof fakeFs>,
	closure: ClosureReader<never> = closes("closed", "not_planned"),
	claims: ClaimsReader<never> = unclaimed,
	token: string | null = null,
	lane = "5983",
	issue: number | null = 5983,
) =>
	Effect.runPromise(
		Effect.provide(
			runCancel({root: ROOT, lane, issue, task: null, token, closure, claims}),
			fs.layer,
		),
	);

describe("lane cancel — the terminal lane 5983 never had", () => {
	it("ends a lane parked before its issue closed not-planned, as one appended line", async () => {
		const fs = laneFs();

		const out = await cancel(fs);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "cancelled",
			lane: "5983",
			issue: 5983,
			previous: {pipeline: {issue: "blocked"}},
			event: "ISSUE.CANCELLED",
			current: "cancelled",
			taskAffected: "issue",
			outcome: "not_planned",
		});
		const appended = fs.written.get(LOG);
		expect(appended?.startsWith(PARKED)).toBe(true);
		expect(JSON.parse((appended ?? "").slice(PARKED.length).trim())).toEqual({
			task: "issue",
			event: "ISSUE.CANCELLED",
			at: expect.any(String),
			outcome: "not_planned",
		});
	});

	it("preserves the whole prior history — the append is the only write to the ledger", async () => {
		const fs = laneFs();

		await cancel(fs);

		const appended = fs.written.get(LOG) ?? "";
		expect(appended.startsWith(PARKED)).toBe(true);
		expect(appended.trim().split("\n")).toHaveLength(3);
	});

	it("is read as terminal by `lane status` after the append", async () => {
		const fs = laneFs();
		await cancel(fs);

		const out = await Effect.runPromise(
			Effect.provide(runStatus({root: ROOT, lane: "5983"}), fs.layer),
		);

		expect(JSON.parse(out.stdout)).toMatchObject({stateValue: "cancelled", status: "done"});
	});

	it("frees the seat it held: `seatsIn` counts a cancelled lane no more", async () => {
		const fs = laneFs();
		const before = await Effect.runPromise(Effect.provide(seatsIn(ROOT), fs.layer));
		expect(before).toEqual({_tag: "Counted", seats: [{lane: "5983", held: "active"}]});

		await cancel(fs);

		const after = await Effect.runPromise(Effect.provide(seatsIn(ROOT), fs.layer));
		expect(after).toEqual({_tag: "Counted", seats: []});
	});

	it("drops out of the stale sweep as terminal, so it can never be stale again", async () => {
		const fs = laneFs();
		await cancel(fs);

		const out = await Effect.runPromise(
			Effect.provide(
				runStale({
					roots: [ROOT],
					olderThanMinutes: 60,
					now: "2026-09-07T00:00:00.000Z",
					claims: null,
				}),
				fs.layer,
			),
		);

		expect(JSON.parse(out.stdout)).toMatchObject({
			lanes: [{key: "5983", verdict: "terminal"}],
		});
	});

	it("refuses an open issue with the log unappended — that is live work nobody dropped", async () => {
		const fs = laneFs();

		const out = await cancel(fs, closes("open", null));

		expect(out.code).toBe(ISSUE_LIVE);
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("refuses a completed close and names the shipped path instead", async () => {
		const fs = laneFs();

		const out = await cancel(fs, closes("closed", "completed"));

		expect(out.code).toBe(CLOSURE_LANDED);
		expect(out.stderr.join(" ")).toContain("fabrika lane reconcile");
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("appends nothing on an unreadable board — UNKNOWN is never a closure", async () => {
		const fs = laneFs();

		const out = await cancel(fs, unreadableBoard);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("appends nothing on a close whose reason nobody can classify", async () => {
		const fs = laneFs();

		const out = await cancel(fs, closes("closed", null));

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("refuses a lane another session is driving, naming the token that holds it", async () => {
		const fs = laneFs();

		const out = await cancel(fs, closes("closed", "not_planned"), claimedBy("lane:abc"), null);

		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.join(" ")).toContain("lane:abc");
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("lets the driver holding the claim cancel its own lane", async () => {
		const fs = laneFs();

		const out = await cancel(
			fs,
			closes("closed", "not_planned"),
			claimedBy("lane:abc"),
			"lane:abc",
		);

		expect(out.code).toBe(0);
	});

	it("reads an unreadable claim thread as UNKNOWN, never as unclaimed", async () => {
		const fs = laneFs();

		const out = await cancel(fs, closes("closed", "not_planned"), unreadableClaims);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("refuses a lane that already carries a terminal, before any board read", async () => {
		const fs = laneFs(`${PARKED}${line("UNBLOCKED")}${line("DONE")}${line("PASS")}${line("DONE")}`);
		const board: ClosureReader<never> = () => {
			throw new Error("the board must not be read for a lane already terminal");
		};

		const out = await cancel(fs, board);

		expect(out.code).toBe(EVENT_REFUSED);
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("refuses a chore lane: it drives no issue, so no closure can ever entitle it", async () => {
		const fs = fakeFs({
			files: {[`${DEFAULT_CHORES_ROOT}/park-sweep/workflow.json`]: choreTemplateText()},
		});

		const out = await Effect.runPromise(
			Effect.provide(
				runCancel({
					root: DEFAULT_CHORES_ROOT,
					lane: "park-sweep",
					issue: null,
					task: null,
					token: null,
					closure: closes("closed", "not_planned"),
					claims: unclaimed,
				}),
				fs.layer,
			),
		);

		expect(out.code).toBe(ISSUE_UNRESOLVED);
	});

	it("refuses a task that is not in the machine", async () => {
		const fs = laneFs();

		const out = await Effect.runPromise(
			Effect.provide(
				runCancel({
					root: ROOT,
					lane: "5983",
					issue: 5983,
					task: "nope",
					token: null,
					closure: closes("closed", "not_planned"),
					claims: unclaimed,
				}),
				fs.layer,
			),
		);

		expect(out.code).toBe(TASK_UNKNOWN);
	});
});
