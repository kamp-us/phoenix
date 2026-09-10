import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {ParkCauseSurface} from "../config/keys/park-cause.ts";
import type {Read} from "../config/read-key.ts";
import {fakeFs} from "../fakes.test-support.ts";
import {refuse} from "../verb.ts";
import {
	APPEND_UNKNOWN,
	CAUSE_UNRECOGNISED,
	CLASS_UNRECOGNISED,
	EVENT_REFUSED,
	LANE_ABSENT,
	LANE_UNREADABLE,
	PARK_UNCAUSED,
	PROOF_CONTRADICTED,
	RATIONALE_REFUSED,
	TASK_UNKNOWN,
} from "./codes.ts";
import {coderTemplateText, fakeProver, parkCauseRead} from "./fixtures.test-support.ts";
import {PARK_CAUSE_TOKENS} from "./report.ts";
import {runTransition} from "./transition-verb.ts";

const ROOT = ".fabrika/lanes";
const WORKFLOW = `${ROOT}/42/workflow.json`;
const LOG = `${ROOT}/42/events.jsonl`;

const logLine = (event: string): string =>
	`${JSON.stringify({task: "issue", event: `ISSUE.${event}`, at: "2026-08-16T00:00:00.000Z"})}\n`;

const run = (
	fs: ReturnType<typeof fakeFs>,
	event: string,
	task: string | null = null,
	cause: string | null = null,
	classes: ReadonlyArray<string> = [],
	waitGrant: number | null = null,
	parkCause: Read<ParkCauseSurface> = parkCauseRead(),
	rationale: string | null = null,
	prover: ReturnType<typeof fakeProver> = fakeProver(),
) =>
	Effect.runPromise(
		Effect.provide(
			runTransition(
				{
					root: ROOT,
					lane: "42",
					event,
					task,
					cause,
					parkCause,
					classes,
					waitGrant,
					rationale,
					repo: "o/r",
					cwd: "/checkout",
					env: {},
				},
				prover.prove,
			),
			fs.layer,
		),
	);

const freshLane = (log?: string, extra: Parameters<typeof fakeFs>[0] = {}) =>
	fakeFs({
		files: {[WORKFLOW]: coderTemplateText(), ...(log === undefined ? {} : {[LOG]: log})},
		...extra,
	});

describe("lane transition — the answer", () => {
	it("appends the accepted event and answers the two stateValues around the fold", async () => {
		const fs = freshLane();

		const out = await run(fs, "WIP");
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			previous: {pipeline: {issue: "queued"}},
			event: "ISSUE.WIP",
			current: {pipeline: {issue: "build"}},
			taskAffected: "issue",
		});

		const appended = fs.written.get(LOG);
		expect(appended).toBeDefined();
		expect(JSON.parse(appended?.trim() ?? "")).toMatchObject({task: "issue", event: "ISSUE.WIP"});
	});

	it("folds the existing log first, so the event lands on the folded state", async () => {
		const fs = freshLane(logLine("WIP"));

		const out = await run(fs, "DONE");
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			previous: {pipeline: {issue: "build"}},
			current: {pipeline: {issue: "review"}},
		});
	});

	it("folds a lower-case event to the operator's spelling", async () => {
		const out = await run(freshLane(), "wip");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({event: "ISSUE.WIP"});
	});
});

describe("lane transition — refuse without append", () => {
	it("refuses an event the state holds no cell for, log byte-identical, nothing written", async () => {
		const fs = freshLane(logLine("WIP"));

		const out = await run(fs, "PASS");
		expect(out.code).toBe(EVENT_REFUSED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("NoCellError");
		expect(out.stderr.at(-1)).toContain("log unappended");
		expect(fs.written.size).toBe(0);
	});

	it("refuses an event outside the operator's set the same way", async () => {
		const fs = freshLane();

		const out = await run(fs, "MERGE");
		expect(out.code).toBe(EVENT_REFUSED);
		expect(fs.written.size).toBe(0);
	});

	it("refuses a task the machine does not have on its own code", async () => {
		const fs = freshLane();

		const out = await run(fs, "WIP", "nope");
		expect(out.code).toBe(TASK_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('"nope"');
		expect(fs.written.size).toBe(0);
	});

	it("refuses a lane that is provably not there, naming the remedy", async () => {
		const fs = fakeFs({files: {}});

		const out = await run(fs, "WIP");
		expect(out.code).toBe(LANE_ABSENT);
		expect(out.stderr.at(-1)).toContain("template");
		expect(fs.written.size).toBe(0);
	});

	it("reports an append that did not land as NOT recorded, never as an answer", async () => {
		const fs = freshLane(undefined, {unwritable: [LOG]});

		const out = await run(fs, "WIP");
		expect(out.code).toBe(APPEND_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("NOT recorded");
	});

	it("seats its codes above the reserved band, distinct from each other", () => {
		const codes = [LANE_ABSENT, EVENT_REFUSED, TASK_UNKNOWN, APPEND_UNKNOWN, CAUSE_UNRECOGNISED];
		expect(new Set(codes).size).toBe(codes.length);
		for (const code of codes) expect(code).toBeGreaterThanOrEqual(3);
	});
});

describe("lane transition — the park cause a driver-originated BLOCKED carries", () => {
	it("records a known cause on the event line", async () => {
		const fs = freshLane(logLine("WIP"));

		const out = await run(fs, "BLOCKED", null, "worktree-holds-branch");

		expect(out.code).toBe(0);
		const appended = JSON.parse(fs.written.get(LOG)?.trim().split("\n").at(-1) ?? "");
		expect(appended).toMatchObject({event: "ISSUE.BLOCKED", cause: "worktree-holds-branch"});
	});

	it("records campaign-paused, the cause a recipe clears by re-reading the row", async () => {
		const fs = freshLane(logLine("WIP"));

		const out = await run(fs, "BLOCKED", null, "campaign-paused");

		expect(out.code).toBe(0);
		const appended = JSON.parse(fs.written.get(LOG)?.trim().split("\n").at(-1) ?? "");
		expect(appended).toMatchObject({event: "ISSUE.BLOCKED", cause: "campaign-paused"});
	});

	it("refuses a cause outside the closed set, log byte-identical", async () => {
		const fs = freshLane(logLine("WIP"));

		const out = await run(fs, "BLOCKED", null, "the-tree-was-busy");

		expect(out.code).toBe(CAUSE_UNRECOGNISED);
		expect(out.stderr.at(-1)).toContain("log unappended");
		expect(fs.written.size).toBe(0);
	});

	it("refuses a cause on an event that is not a park", async () => {
		const fs = freshLane();

		const out = await run(fs, "WIP", null, "worktree-holds-branch");

		expect(out.code).toBe(CAUSE_UNRECOGNISED);
		expect(fs.written.size).toBe(0);
	});

	it("appends a causeless event with no cause key, exactly as it always did", async () => {
		const fs = freshLane(logLine("WIP"));

		const out = await run(fs, "BLOCKED");

		expect(out.code).toBe(0);
		const appended = JSON.parse(fs.written.get(LOG)?.trim().split("\n").at(-1) ?? "");
		expect(Object.keys(appended).sort()).toEqual(["at", "event", "task"]);
	});
});

describe("lane transition — a cause-less park under `parkCause.uncaused: refuse`", () => {
	const strict = parkCauseRead("refuse");

	it("refuses the bare BLOCKED at its own code, log byte-identical", async () => {
		const fs = freshLane(logLine("WIP"));

		const out = await run(fs, "BLOCKED", null, null, [], null, strict);

		expect(out.code).toBe(PARK_UNCAUSED);
		expect(fs.written.has(LOG)).toBe(false);
		// Its own code, not the unknown-cause one: that remedy is "drop or respell", this one's is
		// the opposite — name a cause.
		expect(out.code).not.toBe(CAUSE_UNRECOGNISED);
		for (const cause of PARK_CAUSE_TOKENS) expect(out.stderr.join(" ")).toContain(cause);
	});

	it("records the same BLOCKED once it names a cause", async () => {
		const fs = freshLane(logLine("WIP"));

		const out = await run(fs, "BLOCKED", null, "campaign-paused", [], null, strict);

		expect(out.code).toBe(0);
		const appended = JSON.parse(fs.written.get(LOG)?.trim().split("\n").at(-1) ?? "");
		expect(appended).toMatchObject({event: "ISSUE.BLOCKED", cause: "campaign-paused"});
	});

	it("leaves every non-park event alone — the key binds BLOCKED and nothing else", async () => {
		const fs = freshLane();

		const out = await run(fs, "WIP", null, null, [], null, strict);

		expect(out.code).toBe(0);
	});

	it("refuses UNKNOWN on a config nobody could read, rather than recording the bare park", async () => {
		const fs = freshLane(logLine("WIP"));

		const out = await run(fs, "BLOCKED", null, null, [], null, {
			_tag: "Refused",
			reason: "EACCES",
		});

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.has(LOG)).toBe(false);
	});
});

describe("lane transition — the lane class the `class:<name>` arms route on", () => {
	it("records a known class on the event line and routes the arm that reads it", async () => {
		const fs = freshLane();

		const out = await run(fs, "WIP", null, null, ["ui"]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({current: {pipeline: {issue: "build:ui"}}});
		const appended = JSON.parse(fs.written.get(LOG)?.trim().split("\n").at(-1) ?? "");
		expect(appended).toMatchObject({event: "ISSUE.WIP", classes: ["ui"]});
	});

	it("refuses a class outside the closed set instead of routing it as unclassed", async () => {
		const fs = freshLane();

		// The miss this closes: `UI` matched no `class:ui` arm, so the guarded array fell through and
		// the lane built plain — a routing failure nothing said out loud.
		const out = await run(fs, "WIP", null, null, ["UI-ish"]);

		expect(out.code).toBe(CLASS_UNRECOGNISED);
		expect(out.stderr.at(-1)).toContain("log unappended");
		expect(fs.written.size).toBe(0);
	});

	it("normalises a class's spelling the way a cause's is normalised", async () => {
		const fs = freshLane();

		const out = await run(fs, "WIP", null, null, [" UI "]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({current: {pipeline: {issue: "build:ui"}}});
	});
});

describe("lane transition — the rationale a driver's clearance is recorded on", () => {
	/** A lane sitting in the park an `UNBLOCKED` walks back out of. */
	const parked = () => freshLane(logLine("WIP") + logLine("BLOCKED"));

	it("records the rationale on the UNBLOCKED line and echoes it in the answer", async () => {
		const fs = parked();

		const out = await run(fs, "UNBLOCKED", null, null, [], null, undefined, "  rebased the head  ");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			event: "ISSUE.UNBLOCKED",
			rationale: "rebased the head",
		});
		const appended = JSON.parse(fs.written.get(LOG)?.trim().split("\n").at(-1) ?? "");
		expect(appended).toMatchObject({event: "ISSUE.UNBLOCKED", rationale: "rebased the head"});
	});

	it("refuses a blank rationale at its own code, log byte-identical", async () => {
		const fs = parked();

		const out = await run(fs, "UNBLOCKED", null, null, [], null, undefined, "   ");

		expect(out.code).toBe(RATIONALE_REFUSED);
		expect(out.stderr.at(-1)).toContain("log unappended");
		expect(fs.written.size).toBe(0);
	});

	it("refuses one riding an event that clears no park", async () => {
		const fs = freshLane();

		const out = await run(fs, "WIP", null, null, [], null, undefined, "a reason");

		expect(out.code).toBe(RATIONALE_REFUSED);
		expect(fs.written.size).toBe(0);
	});

	it("records the same UNBLOCKED with no rationale at all — the ordinary resume", async () => {
		const fs = parked();

		const out = await run(fs, "UNBLOCKED");

		expect(out.code).toBe(0);
		const appended = JSON.parse(fs.written.get(LOG)?.trim().split("\n").at(-1) ?? "");
		expect(Object.hasOwn(appended, "rationale")).toBe(false);
	});
});

/**
 * The gate that used to be prose a driver read. `operate` laid the proof and the record out as two
 * adjacent one-liners, so a driver chaining them on one shell line appended whatever the proof said
 * — which is how one epic's lane recorded a `BLOCKED` over a `lane prove` that had just refused it.
 */
describe("lane transition — the proof gate", () => {
	it("refuses on the prover's own code with the log byte-identical", async () => {
		const fs = freshLane(logLine("WIP"));
		const prover = fakeProver(
			refuse(PROOF_CONTRADICTED, "fabrika lane prove: unproven — #7954 holds a FAIL"),
		);

		const out = await run(fs, "DONE", null, null, [], null, undefined, null, prover);

		expect(out.code).toBe(PROOF_CONTRADICTED);
		expect(out.stderr.join(" ")).toContain("holds a FAIL");
		expect(out.stderr.join(" ")).toContain("log unappended");
		// The refusal reads as `lane prove`'s, because its remedies are.
		expect(out.stderr.join(" ")).toContain("fabrika lane prove");
		expect(fs.written.get(LOG)).toBeUndefined();
	});

	it("asks the prover for the event and task it is about to append", async () => {
		const fs = freshLane(logLine("WIP"));
		const prover = fakeProver();

		const out = await run(fs, "DONE", null, null, [], null, undefined, null, prover);

		expect(out.code).toBe(0);
		expect(prover.asked).toEqual([
			{
				root: ROOT,
				lane: "42",
				event: "DONE",
				task: "issue",
				classes: null,
				pr: null,
				repo: "o/r",
				cwd: "/checkout",
				env: {},
			},
		]);
	});

	it("hands the prover the same classes the append carries", async () => {
		const fs = freshLane(logLine("WIP") + logLine("DONE"));
		const prover = fakeProver();

		const out = await run(fs, "PASS", null, null, ["ui"], null, undefined, null, prover);

		expect(out.code).toBe(0);
		expect(prover.asked[0]).toMatchObject({event: "PASS", classes: ["ui"]});
	});

	it("never reaches the prover for an event the machine refuses", async () => {
		const fs = freshLane(logLine("WIP"));
		const prover = fakeProver();

		const out = await run(fs, "WIP", null, null, [], null, undefined, null, prover);

		expect(out.code).toBe(EVENT_REFUSED);
		expect(prover.asked).toEqual([]);
		expect(fs.written.get(LOG)).toBeUndefined();
	});

	it("records the prover's own fields on the driver's line, as `lane report` records them", async () => {
		const fs = freshLane(logLine("WIP") + logLine("DONE"));
		const prover = fakeProver(undefined, ["review-ui"], null, []);

		const out = await run(fs, "PASS", null, null, ["ui"], null, undefined, null, prover);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({deferred: ["review-ui"]});
		const appended = JSON.parse(fs.written.get(LOG)?.trim().split("\n").at(-1) ?? "");
		expect(appended.deferred).toEqual(["review-ui"]);
	});

	// `partial` reaches the line through `applyEvent`'s payload rather than the entry spread the
	// other prover fields take, and it is the one that routes: it picks the `merge:partial` arm.
	it("records the prover's `partial` on the line and routes the merge back to queued", async () => {
		const fs = freshLane(logLine("WIP") + logLine("DONE") + logLine("PASS"));
		const prover = fakeProver(undefined, [], true, [4242]);

		const out = await run(fs, "DONE", null, null, [], null, undefined, null, prover);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			previous: {pipeline: {issue: "ship"}},
			current: {pipeline: {issue: "queued"}},
			partial: true,
			landed: [4242],
		});
		const appended = JSON.parse(fs.written.get(LOG)?.trim().split("\n").at(-1) ?? "");
		expect(appended.partial).toBe(true);
	});

	it("records a discharged `partial` as false and lets the merge land", async () => {
		const fs = freshLane(logLine("WIP") + logLine("DONE") + logLine("PASS"));
		const prover = fakeProver(undefined, [], false, [4242]);

		const out = await run(fs, "DONE", null, null, [], null, undefined, null, prover);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			current: "complete",
			partial: false,
		});
		const appended = JSON.parse(fs.written.get(LOG)?.trim().split("\n").at(-1) ?? "");
		expect(appended.partial).toBe(false);
	});
});
