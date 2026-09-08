/**
 * `lane settle` on the two stranded shapes: lane 5983, parked at `blocked` with its issue closed
 * not-planned, and a hand-shipped lane sitting in `review` with its issue closed completed over a
 * merged PR its own flow never recorded. Both got hand-deleted or left owed; both settle here — and
 * every read that must NOT reach a terminal.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {Claimant} from "../build/claim.ts";
import {fakeFs} from "../fakes.test-support.ts";
import type {ClaimHoldReader} from "./claim-hold.ts";
import {
	CLAIM_NOT_MINE,
	EVENT_REFUSED,
	ISSUE_LIVE,
	ISSUE_UNRESOLVED,
	LANE_UNREADABLE,
	PROOF_ABSENT,
	PROOF_IN_FLIGHT,
	TASK_UNKNOWN,
} from "./codes.ts";
import {seatsIn} from "./concurrency.ts";
import {choreTemplateText, coderTemplateText} from "./fixtures.test-support.ts";
import type {NominatedPull} from "./nominate.ts";
import {
	type AssertedReader,
	type ClaimsReader,
	type ClosureReader,
	type PullsReader,
	runSettle,
	type ShaReader,
} from "./settle-verb.ts";
import {runStale} from "./stale-verb.ts";
import {runStatus} from "./status-verb.ts";
import {DEFAULT_CHORES_ROOT} from "./store.ts";

const ROOT = ".fabrika/lanes";
const LANE = "5983";
const DIR = `${ROOT}/${LANE}`;
const WORKFLOW = `${DIR}/workflow.json`;
const LOG = `${DIR}/events.jsonl`;
const ISSUE = 5983;
const SHA = "b0ab5804263e3ca232aa950e906b997e0e6b1963";

const line = (event: string): string =>
	`${JSON.stringify({task: "issue", event: `ISSUE.${event}`, at: "2026-08-29T00:00:00.000Z"})}\n`;

/** Lane 5983's own shape: driven into `build`, then parked. */
const PARKED = `${line("WIP")}${line("BLOCKED")}`;

/** The hand-shipped shape: driven to `review` and left there while the PR merged elsewhere. */
const AT_REVIEW = `${line("WIP")}${line("DONE")}`;

const closes =
	(state: "open" | "closed", reason: string | null): ClosureReader<never> =>
	() =>
		Effect.succeed({_tag: "Read", state, reason});

const unreadableBoard: ClosureReader<never> = () =>
	Effect.succeed({_tag: "Unknown", reason: "the API answered 503"});

const pull = (over: Partial<NominatedPull> = {}): NominatedPull => ({
	number: 6874,
	open: false,
	merged: true,
	linkedIssues: [ISSUE],
	linkKind: "fixes",
	htmlUrl: "https://example.test/o/r/pull/6874",
	...over,
});

const nominates =
	(pulls: ReadonlyArray<NominatedPull>): PullsReader<never> =>
	() =>
		Effect.succeed({_tag: "Nominated", pulls});

const noPulls: PullsReader<never> = nominates([]);

const unreadablePulls: PullsReader<never> = () =>
	Effect.succeed({_tag: "Unreadable", what: "the pull requests closing #5983", reason: "503"});

const readsSha: ShaReader<never> = () => Effect.succeed(SHA);
const noSha: ShaReader<never> = () => Effect.succeed(null);

const ASSERTED_SHA = "4d0f6bd6c1a0a3e6c1e8b8ee4dcb2f9e0b5f2a11";

const mergedPull =
	(number: number, sha: string | null = ASSERTED_SHA): AssertedReader<never> =>
	() =>
		Effect.succeed({_tag: "Merged", number, sha});

const unmergedPull =
	(number: number, state = "open"): AssertedReader<never> =>
	() =>
		Effect.succeed({_tag: "Unmerged", number, state});

const absentPull =
	(number: number): AssertedReader<never> =>
	() =>
		Effect.succeed({_tag: "Absent", number});

const unreadablePull: AssertedReader<never> = () =>
	Effect.succeed({_tag: "Unknown", reason: "the API answered 503"});

/** The reader a lane that names no `--landed-by` must never reach. */
const forbiddenPull: AssertedReader<never> = () => {
	throw new Error("the named-pull read ran with no --landed-by");
};

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
		dirs: {[ROOT]: [LANE]},
		directories: [ROOT],
	});

interface SettleOverrides {
	readonly closure?: ClosureReader<never>;
	readonly pulls?: PullsReader<never>;
	readonly claims?: ClaimsReader<never>;
	readonly sha?: ShaReader<never>;
	readonly asserted?: AssertedReader<never>;
	readonly landedBy?: number | null;
	readonly token?: string | null;
	readonly task?: string | null;
}

const settle = (fs: ReturnType<typeof fakeFs>, over: SettleOverrides = {}) =>
	Effect.runPromise(
		Effect.provide(
			runSettle({
				root: ROOT,
				lane: LANE,
				issue: ISSUE,
				task: over.task ?? null,
				token: over.token ?? null,
				landedBy: over.landedBy ?? null,
				closure: over.closure ?? closes("closed", "not_planned"),
				pulls: over.pulls ?? noPulls,
				claims: over.claims ?? unclaimed,
				sha: over.sha ?? readsSha,
				asserted: over.asserted ?? forbiddenPull,
			}),
			fs.layer,
		),
	);

const appendedLine = (fs: ReturnType<typeof fakeFs>, prefix: string) =>
	JSON.parse((fs.written.get(LOG) ?? "").slice(prefix.length).trim());

describe("lane settle — the cancellation arm", () => {
	it("ends a lane parked before its issue closed not-planned, as one appended line", async () => {
		const fs = laneFs();

		const out = await settle(fs);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "settled",
			lane: LANE,
			issue: ISSUE,
			previous: {pipeline: {issue: "blocked"}},
			event: "ISSUE.CANCELLED",
			current: "board:cancelled",
			taskAffected: "issue",
			outcome: "not_planned",
		});
		expect(appendedLine(fs, PARKED)).toEqual({
			task: "issue",
			event: "ISSUE.CANCELLED",
			at: expect.any(String),
			outcome: "not_planned",
		});
	});

	it("ends a duplicate close the same way — `triage kill`'s own shape", async () => {
		const fs = laneFs();

		const out = await settle(fs, {closure: closes("closed", "duplicate")});

		expect(JSON.parse(out.stdout)).toMatchObject({event: "ISSUE.CANCELLED", outcome: "duplicate"});
	});

	it("costs no pull-request read: a cancellation stands on the closure alone", async () => {
		const fs = laneFs();
		const forbidden: PullsReader<never> = () => {
			throw new Error("a cancellation must not read pull requests");
		};

		expect((await settle(fs, {pulls: forbidden})).code).toBe(0);
	});
});

describe("lane settle — the landing arm", () => {
	it("ends a hand-shipped lane sitting in review over a merged linking PR", async () => {
		const fs = laneFs(AT_REVIEW);

		const out = await settle(fs, {
			closure: closes("closed", "completed"),
			pulls: nominates([pull()]),
		});

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "settled",
			previous: {pipeline: {issue: "review"}},
			event: "ISSUE.LANDED",
			current: "board:landed",
			outcome: "completed",
			landed: [6874],
			sha: SHA,
		});
		expect(appendedLine(fs, AT_REVIEW)).toEqual({
			task: "issue",
			event: "ISSUE.LANDED",
			at: expect.any(String),
			outcome: "completed",
			landed: [6874],
			sha: SHA,
		});
	});

	it("counts a merged `Part of` PR as landed evidence, not only a closing keyword", async () => {
		const fs = laneFs(AT_REVIEW);

		const out = await settle(fs, {
			closure: closes("closed", "completed"),
			pulls: nominates([pull({linkKind: "part-of"})]),
		});

		expect(JSON.parse(out.stdout)).toMatchObject({event: "ISSUE.LANDED", landed: [6874]});
	});

	it("records the landing without a sha when the board published none", async () => {
		const fs = laneFs(AT_REVIEW);

		const out = await settle(fs, {
			closure: closes("closed", "completed"),
			pulls: nominates([pull()]),
			sha: noSha,
		});

		expect(out.code).toBe(0);
		expect(appendedLine(fs, AT_REVIEW)).not.toHaveProperty("sha");
	});

	it("frees the seat a hand-shipped lane was holding", async () => {
		const fs = laneFs(AT_REVIEW);
		const held: ClaimHoldReader<never> = () => Effect.succeed({_tag: "Claimed", token: "t"});
		const before = await Effect.runPromise(Effect.provide(seatsIn(ROOT, held), fs.layer));
		expect(before).toEqual({_tag: "Counted", seats: [{lane: LANE, held: "claimed"}], idle: []});

		await settle(fs, {closure: closes("closed", "completed"), pulls: nominates([pull()])});

		expect(await Effect.runPromise(Effect.provide(seatsIn(ROOT, held), fs.layer))).toEqual({
			_tag: "Counted",
			seats: [],
			idle: [],
		});
	});

	it("is read as terminal by `lane status` after the append", async () => {
		const fs = laneFs(AT_REVIEW);
		await settle(fs, {closure: closes("closed", "completed"), pulls: nominates([pull()])});

		const out = await Effect.runPromise(
			Effect.provide(runStatus({root: ROOT, lane: LANE}), fs.layer),
		);

		expect(JSON.parse(out.stdout)).toMatchObject({stateValue: "board:landed", status: "done"});
	});

	it("refuses a completed close naming no merged linking PR — genuinely unread, not a landing", async () => {
		const fs = laneFs(AT_REVIEW);

		const out = await settle(fs, {closure: closes("closed", "completed"), pulls: noPulls});

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("refuses a completed close whose only candidate never merged", async () => {
		const fs = laneFs(AT_REVIEW);

		const out = await settle(fs, {
			closure: closes("closed", "completed"),
			pulls: nominates([pull({merged: false, open: true})]),
		});

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("refuses a completed close whose merged candidate links another issue", async () => {
		const fs = laneFs(AT_REVIEW);

		const out = await settle(fs, {
			closure: closes("closed", "completed"),
			pulls: nominates([pull({linkedIssues: [4242]})]),
		});

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("appends nothing when the pull requests could not be read", async () => {
		const fs = laneFs(AT_REVIEW);

		const out = await settle(fs, {
			closure: closes("closed", "completed"),
			pulls: unreadablePulls,
		});

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.has(LOG)).toBe(false);
	});
});

describe("lane settle — the asserted landing `--landed-by` supplies", () => {
	it("lands a completed close whose merge names some other issue in its body", async () => {
		const fs = laneFs(AT_REVIEW);

		const out = await settle(fs, {
			closure: closes("closed", "completed"),
			pulls: nominates([pull({linkedIssues: [9001]})]),
			landedBy: 6894,
			asserted: mergedPull(6894),
		});

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			event: "ISSUE.LANDED",
			current: "board:landed",
			outcome: "completed",
			landed: [6894],
			sha: ASSERTED_SHA,
			assertedBy: "caller",
		});
		expect(appendedLine(fs, AT_REVIEW)).toEqual({
			task: "issue",
			event: "ISSUE.LANDED",
			at: expect.any(String),
			outcome: "completed",
			landed: [6894],
			sha: ASSERTED_SHA,
			assertedBy: "caller",
		});
	});

	it("records the asserted landing without a sha when the board published none", async () => {
		const fs = laneFs(AT_REVIEW);

		const out = await settle(fs, {
			closure: closes("closed", "completed"),
			pulls: noPulls,
			landedBy: 6894,
			asserted: mergedPull(6894, null),
		});

		expect(out.code).toBe(0);
		expect(appendedLine(fs, AT_REVIEW)).toMatchObject({assertedBy: "caller"});
		expect(appendedLine(fs, AT_REVIEW)).not.toHaveProperty("sha");
	});

	it("leaves a body-proven landing body-proven: the flag fills a gap and never relabels one", async () => {
		const fs = laneFs(AT_REVIEW);

		const out = await settle(fs, {
			closure: closes("closed", "completed"),
			pulls: nominates([pull()]),
			landedBy: 6894,
			asserted: mergedPull(6894),
		});

		expect(JSON.parse(out.stdout)).toMatchObject({landed: [6874], sha: SHA});
		expect(appendedLine(fs, AT_REVIEW)).not.toHaveProperty("assertedBy");
	});

	it("refuses a named pull request that has not merged, with the log unappended", async () => {
		const fs = laneFs(AT_REVIEW);

		const out = await settle(fs, {
			closure: closes("closed", "completed"),
			pulls: noPulls,
			landedBy: 6894,
			asserted: unmergedPull(6894),
		});

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("refuses a named pull request the board does not hold, with the log unappended", async () => {
		const fs = laneFs(AT_REVIEW);

		const out = await settle(fs, {
			closure: closes("closed", "completed"),
			pulls: noPulls,
			landedBy: 6894,
			asserted: absentPull(6894),
		});

		expect(out.code).toBe(PROOF_ABSENT);
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("stays UNKNOWN when the named pull request could not be read", async () => {
		const fs = laneFs(AT_REVIEW);

		const out = await settle(fs, {
			closure: closes("closed", "completed"),
			pulls: noPulls,
			landedBy: 6894,
			asserted: unreadablePull,
		});

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("reads no named pull request on a cancellation — the closure alone entitles it", async () => {
		const fs = laneFs();

		const out = await settle(fs, {landedBy: 6894, asserted: forbiddenPull});

		expect(out.code).toBe(0);
		expect(appendedLine(fs, PARKED)).toMatchObject({event: "ISSUE.CANCELLED"});
	});
});

describe("lane settle — what never reaches a terminal", () => {
	it("drops out of the stale sweep as terminal, so it can never be stale again", async () => {
		const fs = laneFs();
		await settle(fs);

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

		expect(JSON.parse(out.stdout)).toMatchObject({lanes: [{key: LANE, verdict: "terminal"}]});
	});

	it("preserves the whole prior history — the append is the only write to the ledger", async () => {
		const fs = laneFs();

		await settle(fs);

		const appended = fs.written.get(LOG) ?? "";
		expect(appended.startsWith(PARKED)).toBe(true);
		expect(appended.trim().split("\n")).toHaveLength(3);
	});

	it("refuses an open issue with the log unappended — that closure has said nothing yet", async () => {
		const fs = laneFs();

		const out = await settle(fs, {closure: closes("open", null)});

		expect(out.code).toBe(ISSUE_LIVE);
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("appends nothing on an unreadable board — UNKNOWN is never a closure", async () => {
		const fs = laneFs();

		const out = await settle(fs, {closure: unreadableBoard});

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("appends nothing on a close carrying no reason", async () => {
		const fs = laneFs();

		const out = await settle(fs, {closure: closes("closed", null)});

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("appends nothing on a reason outside the three", async () => {
		const fs = laneFs();

		const out = await settle(fs, {closure: closes("closed", "reopened")});

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("refuses a lane another session is driving, naming the token that holds it", async () => {
		const fs = laneFs();

		const out = await settle(fs, {claims: claimedBy("lane:abc")});

		expect(out.code).toBe(CLAIM_NOT_MINE);
		expect(out.stderr.join(" ")).toContain("lane:abc");
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("lets the driver holding the claim settle its own lane", async () => {
		const fs = laneFs();

		expect((await settle(fs, {claims: claimedBy("lane:abc"), token: "lane:abc"})).code).toBe(0);
	});

	it("reads an unreadable claim thread as UNKNOWN, never as unclaimed", async () => {
		const fs = laneFs();

		const out = await settle(fs, {claims: unreadableClaims});

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("refuses a lane that already carries a terminal, before any board read", async () => {
		const fs = laneFs(`${PARKED}${line("UNBLOCKED")}${line("DONE")}${line("PASS")}${line("DONE")}`);
		const forbidden: ClosureReader<never> = () => {
			throw new Error("the board must not be read for a lane already terminal");
		};

		const out = await settle(fs, {closure: forbidden});

		expect(out.code).toBe(EVENT_REFUSED);
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("refuses a chore lane: it drives no issue, so no closure can ever entitle it", async () => {
		const fs = fakeFs({
			files: {[`${DEFAULT_CHORES_ROOT}/park-sweep/workflow.json`]: choreTemplateText()},
		});

		const out = await Effect.runPromise(
			Effect.provide(
				runSettle({
					root: DEFAULT_CHORES_ROOT,
					lane: "park-sweep",
					issue: null,
					task: null,
					token: null,
					landedBy: null,
					closure: closes("closed", "not_planned"),
					pulls: noPulls,
					claims: unclaimed,
					sha: readsSha,
					asserted: forbiddenPull,
				}),
				fs.layer,
			),
		);

		expect(out.code).toBe(ISSUE_UNRESOLVED);
	});

	it("refuses a task that is not in the machine", async () => {
		const fs = laneFs();

		expect((await settle(fs, {task: "nope"})).code).toBe(TASK_UNKNOWN);
	});
});
