/** `lane record` and `lane wait` — posting once per terminal, the leak scrub, and the wait fact. */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {reviewUiKey} from "../config/keys/review-ui.ts";
import {uiSurfacesKey} from "../config/keys/ui-surfaces.ts";
import {loadConfig} from "../config/load.ts";
import {readFromLoad} from "../config/read-key.ts";
import {SCREEN_CHECK_SKIPPED, screenReviewOf} from "../config/screen-review.ts";
import {fakeFs} from "../fakes.test-support.ts";
import {fail, ok} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {read} from "../wire/lane-record.ts";
import {seedClasses} from "./class-seed.ts";
import {
	APPEND_UNKNOWN,
	FACT_REFUSED,
	ISSUE_LIVE,
	ISSUE_UNRESOLVED,
	LANE_ABSENT,
	LANE_NOT_TERMINAL,
	LANE_UNREADABLE,
	MALFORMED_RECORD,
	MARKER_READBACK,
} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {LEDGER_SPEND} from "./record.ts";
import {type IssueComment, type RecordBoard, runRecord} from "./record-verb.ts";
import {readScreenCheck} from "./screen-check.ts";
import {runWait} from "./wait-verb.ts";

const ROOT = ".fabrika/lanes";
const LANE = "42";
const ROW = {name: "web", prefix: "src/", mount: "/", command: "pnpm dev --port {{port}}"};
const WORKFLOW = `${ROOT}/${LANE}/workflow.json`;
const LOG = `${ROOT}/${LANE}/events.jsonl`;
const FACTS = `${ROOT}/${LANE}/facts.jsonl`;

let tick = 0;
const line = (event: string, extra: Record<string, unknown> = {}): string =>
	`${JSON.stringify({task: "issue", event: `ISSUE.${event}`, at: new Date(Date.UTC(2026, 8, 26, 6, tick++)).toISOString(), ...extra})}\n`;

const shipped = (rationale?: string): string => {
	tick = 0;
	return [
		line("WIP"),
		line("DONE", {pr: "https://forge.test/o/r/pull/12"}),
		line("PASS"),
		line("BLOCKED", {cause: "awaiting-cp-approval"}),
		line("UNBLOCKED", rationale === undefined ? {} : {rationale}),
		line("DONE", {landed: [12]}),
	].join("");
};

const laneFs = (log: string, facts?: string) =>
	fakeFs({
		files: {
			[WORKFLOW]: coderTemplateText(),
			[LOG]: log,
			...(facts === undefined ? {} : {[FACTS]: facts}),
		},
		dirs: {[ROOT]: [LANE]},
		directories: [ROOT],
	});

/** One issue read at `state`, as `getIssue` serves it. */
const issueReads = (state: string) =>
	({_tag: "Present", value: {state, isPullRequest: false}}) as const;

/** An in-memory issue thread: what was posted, and what the read-back serves. */
const thread = (
	standing: ReadonlyArray<IssueComment> = [],
	over: Partial<RecordBoard<never>> = {},
) => {
	const posted: string[] = [];
	const comments: IssueComment[] = [...standing];
	const board: RecordBoard<never> = {
		issue: () => Effect.succeed(issueReads("closed")),
		comments: () => Effect.succeed(ok([...comments])),
		post: (_issue, body) =>
			Effect.sync(() => {
				posted.push(body);
				comments.push({id: 100 + posted.length, body});
				return ok({
					id: 100 + posted.length,
					url: `https://forge.test/o/r/comments/${100 + posted.length}`,
				});
			}),
		readBack: (id) => Effect.succeed(ok(comments.find((comment) => comment.id === id)?.body ?? "")),
		...over,
	};
	return {board, posted};
};

const record = (fs: ReturnType<typeof fakeFs>, board: RecordBoard<never>, issue = true) =>
	Effect.runPromise(
		Effect.provide(
			runRecord({
				root: ROOT,
				lane: LANE,
				issue: issue ? {_tag: "Issue", number: 42} : {_tag: "Chore"},
				spent: LEDGER_SPEND,
				board,
			}),
			fs.layer,
		),
	);

describe("lane record, then the table", () => {
	const recordThenSync = (
		board: RecordBoard<never>,
		syncTable: (issue: number) => Effect.Effect<VerbOutcome>,
	) =>
		Effect.runPromise(
			Effect.provide(
				runRecord({
					root: ROOT,
					lane: LANE,
					issue: {_tag: "Issue", number: 42},
					spent: LEDGER_SPEND,
					board,
					syncTable,
				}),
				laneFs(shipped()).layer,
			),
		);

	it("syncs the lane's issue once its record stands, posted now or already there", async () => {
		const synced: number[] = [];
		const {board} = thread();
		const syncTable = (issue: number) =>
			Effect.sync(() => {
				synced.push(issue);
				return answer(JSON.stringify({answer: synced.length === 1 ? "synced" : "unchanged"}));
			});

		const first = await recordThenSync(board, syncTable);
		const second = await recordThenSync(board, syncTable);

		expect(synced).toEqual([42, 42]);
		expect(JSON.parse(first.stdout).table).toEqual({code: 0, answer: "synced"});
		expect(JSON.parse(second.stdout)).toMatchObject({
			answer: "unchanged",
			table: {code: 0, answer: "unchanged"},
		});
	});

	it("keeps the record when the sync refuses, and names the re-run", async () => {
		const {board, posted} = thread();

		const outcome = await recordThenSync(board, () =>
			Effect.succeed(refuse(20, "table sync: the GitHub token lacks the `project` scope")),
		);

		expect(outcome.code).toBe(0);
		expect(posted).toHaveLength(1);
		expect(JSON.parse(outcome.stdout)).toMatchObject({answer: "posted", table: {code: 20}});
		expect(outcome.stderr.join("\n")).toContain("`project` scope");
		expect(outcome.stderr.join("\n")).toContain("fabrika table sync 42");
	});
});

describe("lane record", () => {
	it("posts one record for a terminal lane, and a re-run for the same terminal writes nothing", async () => {
		const fs = laneFs(shipped());
		const {board, posted} = thread();

		const first = await record(fs, board);
		const second = await record(fs, board);

		expect(first.code).toBe(0);
		expect(JSON.parse(first.stdout)).toMatchObject({
			answer: "posted",
			issue: 42,
			outcome: "complete",
			origin: "driver-pick",
			asks: 1,
			builds: 1,
			reviews: 1,
			prs: [12],
		});
		expect(second.code).toBe(0);
		expect(JSON.parse(second.stdout)).toMatchObject({answer: "unchanged", commentId: 101});
		expect(posted).toHaveLength(1);
		expect(read(posted[0] ?? "")).toMatchObject({
			_tag: "Found",
			value: {issue: 42, outcome: "complete"},
		});
	});

	it("carries the origin and the standing wait from the lane's facts", async () => {
		const facts = [
			JSON.stringify({kind: "origin", origin: "experiment", at: "2026-09-26T05:00:00.000Z"}),
			JSON.stringify({
				kind: "waiting",
				on: "legal",
				until: "2026-10-05",
				at: "2026-09-26T05:30:00.000Z",
			}),
		].join("\n");
		const {board, posted} = thread();

		await record(laneFs(shipped(), facts), board);

		expect(posted[0]).toContain("| Origin | experiment |");
		expect(posted[0]).toContain("| Waiting | on legal until 2026-10-05 |");
	});

	it("scrubs a machine-local path out of the log before it reaches the issue", async () => {
		const {board, posted} = thread();

		const out = await record(
			laneFs(shipped("cleared after reading /Users/someone/notes.md")),
			board,
		);

		expect(out.code).toBe(0);
		expect(posted[0]).not.toContain("/Users/someone");
		expect(posted[0]).toContain("/Users/<redacted>");
		expect(out.stderr.join("\n")).toContain("scrubbed 1 machine-local path");
	});

	it("posts no worktree path from the in-flight record", async () => {
		const tree = "/Users/someone/repo/.claude/worktrees/agent-a1b2";
		const records = [
			JSON.stringify({
				kind: "dispatched",
				task: "issue",
				state: "build",
				at: "2026-09-26T06:00:30.000Z",
			}),
			JSON.stringify({
				kind: "working",
				task: "issue",
				token: "build:session-a:11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				worktree: tree,
				at: "2026-09-26T06:00:40.000Z",
			}),
		].join("\n");
		const fs = fakeFs({
			files: {
				[WORKFLOW]: coderTemplateText(),
				[LOG]: shipped(),
				[`${ROOT}/${LANE}/in-flight.jsonl`]: records,
			},
			dirs: {[ROOT]: [LANE]},
			directories: [ROOT],
		});
		const {board, posted} = thread();

		const out = await record(fs, board);

		expect(out.code).toBe(0);
		expect(posted).toHaveLength(1);
		expect(posted[0]).not.toContain("worktrees/agent-a1b2");
		expect(posted[0]).not.toContain("/Users/");
	});

	it("posts nothing for a lane that has not ended", async () => {
		tick = 0;
		const {board, posted} = thread();

		const out = await record(laneFs(line("WIP")), board);

		expect(out.code).toBe(LANE_NOT_TERMINAL);
		expect(posted).toHaveLength(0);
	});

	it("posts nothing for a chore lane, which has no issue", async () => {
		const {board, posted} = thread();

		const out = await record(laneFs(shipped()), board, false);

		expect(out.code).toBe(ISSUE_UNRESOLVED);
		expect(posted).toHaveLength(0);
	});

	it("refuses when a lane record on the issue does not read, since the terminal may be recorded", async () => {
		const {board, posted} = thread([{id: 7, body: "lane-record: #42 complete\n"}]);

		const out = await record(laneFs(shipped()), board);

		expect(out.code).toBe(MALFORMED_RECORD);
		expect(posted).toHaveLength(0);
	});

	it("keeps an unread thread, a failed post and a drifted read-back on their own codes", async () => {
		const unread = thread([], {comments: () => Effect.succeed(fail("rate limited"))});
		const unposted = thread([], {post: () => Effect.succeed(fail("502"))});
		const drifted = thread([], {readBack: () => Effect.succeed(ok("something else"))});

		expect((await record(laneFs(shipped()), unread.board)).code).toBe(LANE_UNREADABLE);
		expect((await record(laneFs(shipped()), unposted.board)).code).toBe(APPEND_UNKNOWN);
		expect((await record(laneFs(shipped()), drifted.board)).code).toBe(MARKER_READBACK);
	});

	it("refuses a lane that is not there", async () => {
		const {board} = thread();

		const out = await record(fakeFs({files: {}}), board);

		expect(out.code).toBe(LANE_ABSENT);
	});
});

const wait = (fs: ReturnType<typeof fakeFs>, on: string, until: string) =>
	Effect.runPromise(Effect.provide(runWait({root: ROOT, lane: LANE, on, until}), fs.layer));

describe("lane wait", () => {
	it("appends a waiting fact and leaves the event log alone", async () => {
		const fs = laneFs(shipped());

		const out = await wait(fs, "the design review", "2999-01-01");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			answer: "waiting",
			lane: LANE,
			on: "the design review",
			until: "2999-01-01",
		});
		expect(JSON.parse(fs.written.get(FACTS) ?? "")).toMatchObject({
			kind: "waiting",
			on: "the design review",
			until: "2999-01-01",
		});
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("refuses a blank --on, a lapsed --until and one that is not a date", async () => {
		for (const [on, until] of [
			["  ", "2999-01-01"],
			["x", "2000-01-01"],
			["x", "next week"],
		] as const) {
			const fs = laneFs(shipped());
			const out = await wait(fs, on, until);
			expect(out.code).toBe(FACT_REFUSED);
			expect(fs.written.size).toBe(0);
		}
	});
});

/**
 * A merge-queue merge can leave a `Fixes #N` issue open under a lane that folded to `complete`, so
 * a `complete` record is never posted over an issue that reads open or does not read.
 */
describe("lane record — a complete record over an open issue", () => {
	it("refuses at ISSUE_LIVE naming the open issue, and posts nothing", async () => {
		const {board, posted} = thread([], {issue: () => Effect.succeed(issueReads("open"))});

		const out = await record(laneFs(shipped()), board);

		expect(out.code).toBe(ISSUE_LIVE);
		expect(out.stderr.join("\n")).toContain("#42 is still open");
		expect(posted).toEqual([]);
	});

	it("refuses as UNKNOWN where the issue does not read, and posts nothing", async () => {
		const {board, posted} = thread([], {
			issue: () => Effect.succeed({_tag: "Unknown", reason: "HTTP 502"} as const),
		});

		const out = await record(laneFs(shipped()), board);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stderr.join("\n")).toContain("cannot read #42: HTTP 502");
		expect(posted).toEqual([]);
	});

	it("posts the complete record once the issue reads closed", async () => {
		const {board, posted} = thread([], {issue: () => Effect.succeed(issueReads("closed"))});

		const out = await record(laneFs(shipped()), board);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "posted", outcome: "complete"});
		expect(posted).toHaveLength(1);
	});
});

/**
 * The screen check rides the record's answer: one sentence where a screen change went unreviewed
 * because screen review is not set up, and no key at all anywhere else.
 */
describe("lane record, then the screen check", () => {
	const reviewAt = (config: Record<string, unknown>) => {
		const load = loadConfig({_tag: "Text", text: JSON.stringify(config)});
		const reviewUi = readFromLoad(load, reviewUiKey);
		const surfaces = readFromLoad(load, uiSurfacesKey);
		if (reviewUi._tag === "Refused" || surfaces._tag === "Refused") throw new Error("refused");
		return screenReviewOf(reviewUi.value, surfaces.value);
	};

	/** A lane booted off an issue labelled `class:ui`, or one with no class at all. */
	const workflow = (seed: ReadonlyArray<string>): string => {
		const seeded = seedClasses(coderTemplateText(), seed);
		if (seeded._tag !== "Seeded" && seeded._tag !== "Unchanged") throw new Error(seeded._tag);
		return seeded.text;
	};

	/**
	 * {@link shipped}, as a lane seeded `ui` walks it at skip: the head's diff raises no ui class, so
	 * the reviewer relays `code` on its PASS and the lane goes on to ship.
	 */
	const shippedTextOnly = (): string => {
		tick = 0;
		return [
			line("WIP"),
			line("DONE", {pr: "https://forge.test/o/r/pull/12"}),
			line("PASS", {classes: ["code"]}),
			line("BLOCKED", {cause: "awaiting-cp-approval"}),
			line("UNBLOCKED"),
			line("DONE", {landed: [12]}),
		].join("");
	};

	const recorded = (
		seed: ReadonlyArray<string>,
		config: Record<string, unknown>,
		files: ReadonlyArray<string> | null = ["index.html"],
		log: string = shippedTextOnly(),
	) =>
		Effect.runPromise(
			Effect.provide(
				runRecord({
					root: ROOT,
					lane: LANE,
					issue: {_tag: "Issue", number: 42},
					spent: LEDGER_SPEND,
					board: thread().board,
					screenCheck: (lane) =>
						readScreenCheck(lane, {
							review: Effect.succeed({_tag: "Review", review: reviewAt(config)} as const),
							files: () => Effect.succeed(files === null ? fail("HTTP 502") : ok(files)),
						}),
				}),
				fakeFs({
					files: {[WORKFLOW]: workflow(seed), [LOG]: log},
					dirs: {[ROOT]: [LANE]},
					directories: [ROOT],
				}).layer,
			),
		);

	const SKIPPED = {screenCheck: SCREEN_CHECK_SKIPPED};

	it("says the screen check was skipped on a class:ui issue in a repo that declares nothing", async () => {
		const out = await recorded(["ui"], {});
		expect({code: out.code, stderr: out.stderr}).toMatchObject({code: 0});
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "posted", ...SKIPPED});
		expect(out.stderr).toContain(`fabrika lane record: ${SCREEN_CHECK_SKIPPED}`);
	});

	it("says it on a pull request that changes a declared screen file at skip, with no class:ui", async () => {
		const config = {reviewUi: {mode: "skip", screens: ["index.html"]}};
		expect(JSON.parse((await recorded([], config)).stdout)).toMatchObject(SKIPPED);
		expect(JSON.parse((await recorded([], config, ["README.md"])).stdout)).not.toHaveProperty(
			"screenCheck",
		);
	});

	it.each([
		["hand-check", {reviewUi: {mode: "hand-check", screens: ["index.html"]}}],
		["preview", {reviewUi: {mode: "preview", screens: ["index.html"]}}],
		["a repo with rows and no mode", {uiSurfaces: [ROW]}],
	])("prints no skip sentence at %s", async (_, config) => {
		const out = await recorded(["ui"], config);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).not.toHaveProperty("screenCheck");
		expect(out.stderr.join("\n")).not.toContain("screen check");
	});

	it("prints none for a text-only lane in a repo that names no screen file", async () => {
		expect(JSON.parse((await recorded([], {})).stdout)).not.toHaveProperty("screenCheck");
	});

	it("keeps the sentence out of the record posted to the issue", async () => {
		const {board, posted} = thread();
		await Effect.runPromise(
			Effect.provide(
				runRecord({
					root: ROOT,
					lane: LANE,
					issue: {_tag: "Issue", number: 42},
					spent: LEDGER_SPEND,
					board,
					screenCheck: () => Effect.succeed({_tag: "Skipped"} as const),
				}),
				laneFs(shipped()).layer,
			),
		);
		expect(posted[0]).not.toContain("screen check");
	});

	it("says UNKNOWN on stderr and leaves the record standing when a read fails", async () => {
		const out = await recorded([], {reviewUi: {mode: "skip", screens: ["index.html"]}}, null);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).not.toHaveProperty("screenCheck");
		expect(out.stderr.join("\n")).toContain(
			"whether this lane's screen check was skipped is UNKNOWN — cannot read the changed files of #12: HTTP 502",
		);
	});
});

describe("readScreenCheck", () => {
	const never = {
		review: Effect.die("the config was read for a lane with no pull request"),
		files: () => Effect.die("the files were read"),
	};

	it("skips nothing for a lane that opened no pull request, and reads nothing to say so", async () => {
		expect(await Effect.runPromise(readScreenCheck({seededUi: true, prs: []}, never))).toEqual({
			_tag: "NotSkipped",
		});
	});

	it("is UNKNOWN where the repo's config does not read", async () => {
		const check = await Effect.runPromise(
			readScreenCheck(
				{seededUi: true, prs: [12]},
				{...never, review: Effect.succeed({_tag: "Refused", message: "v: refused"} as const)},
			),
		);
		expect(check).toEqual({_tag: "Unread", reason: "v: refused"});
	});
});
