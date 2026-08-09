import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {comments, LANE_UUID, marker} from "../build/fixtures.test-support.ts";
import {errOut, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {runCheck} from "./check-verb.ts";
import {
	CLAIM_NOT_MINE,
	FLOOR_DEFECTIVE,
	LABEL_ABSENT,
	OFF_VOCABULARY,
	PARTIAL_FLIP,
	PLAN_MOVED,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {
	child,
	childBody,
	epic,
	epicBody,
	labelSet,
	SESSION,
	subIssues,
} from "./fixtures.test-support.ts";
import {runFlip} from "./flip-verb.ts";

const EPIC = /^gh api repos\/o\/r\/issues\/4300$/;
const SUBS = /^gh api --paginate repos\/o\/r\/issues\/4300\/sub_issues/;
const CHILD = /^gh api repos\/o\/r\/issues\/4301$/;
const CYCLE = /^gh api repos\/o\/r\/contents\/product-development-cycle\.md$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4300\/comments/;
const PERM = /^gh api repos\/o\/r\/collaborators\/agent\/permission/;
const LABELS = /^gh api --paginate repos\/o\/r\/labels/;
const ADD = /^gh api --method POST repos\/o\/r\/issues\/4301\/labels/;
const REMOVE = /^gh api --method DELETE repos\/o\/r\/issues\/4301\/labels/;

const ONE_CHILD_EPIC = epic({body: epicBody({dependencies: "- phase 1: #4301"})});

const env = {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: SESSION} as Record<
	string,
	string | undefined
>;

const CLAIMED: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[COMMENTS, comments({id: 1, body: marker(SESSION, LANE_UUID)})],
	[PERM, okOut("write\n")],
];

const PLANNED = child({number: 4301, labels: ["type:feature", "p1", "status:planned"]});
const TRIAGED = child({number: 4301, labels: ["type:feature", "p1", "status:triaged"]});

/** The ledger reads, in the order the flip issues them; `once` lets the re-read differ. */
const ledger = (
	first: ExecResult,
	reread: ExecResult,
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[EPIC, ONE_CHILD_EPIC],
	[SUBS, subIssues(4301)],
	[once(CHILD), first],
	[CYCLE, okOut("{}")],
	[CHILD, reread],
];

const digestOf = async (script: ReadonlyArray<readonly [RegExp, ExecResult]>): Promise<string> => {
	const out = await Effect.runPromise(
		Effect.provide(
			runCheck({number: 4300, repo: null, env: {CLAUDE_PIPELINE_REPO: "o/r"}}),
			fakeShell(script).layer,
		),
	);
	return JSON.parse(out.stdout).digest as string;
};

const CLEAN_READ: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[EPIC, ONE_CHILD_EPIC],
	[SUBS, subIssues(4301)],
	[CHILD, PLANNED],
	[CYCLE, okOut("{}")],
];

const run = (digest: string, script: ReadonlyArray<readonly [RegExp, ExecResult]>) => {
	const shell = fakeShell(script);
	return Effect.runPromise(
		Effect.provide(runFlip({number: 4300, digest, repo: null, env}), shell.layer),
	).then((outcome) => ({outcome, calls: shell.calls}));
};

describe("runFlip", () => {
	it("flips a planned child and reports the OBSERVED labels", async () => {
		const digest = await digestOf(CLEAN_READ);
		const {outcome} = await run(digest, [
			...CLAIMED,
			...ledger(PLANNED, TRIAGED),
			[LABELS, labelSet("status:planned", "status:triaged", "type:feature")],
			[ADD, okOut("[]")],
			[REMOVE, okOut("[]")],
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			answer: "flipped",
			terminal: "flipped-all",
			flipped: 1,
			already: 0,
			children: [
				{number: 4301, observed: ["p1", "status:triaged", "type:feature"], result: "flipped"},
			],
		});
	});

	/**
	 * `status:triaged` is added BEFORE `status:planned` is removed, always. Swap the two calls and a
	 * child caught between them carries no `status:` label at all — `MISSING_LABEL` flips true and
	 * `plan verdict` then re-derives a defective floor on a run the gate believes clean.
	 */
	it("adds before it removes", async () => {
		const digest = await digestOf(CLEAN_READ);
		const {calls} = await run(digest, [
			...CLAIMED,
			...ledger(PLANNED, TRIAGED),
			[LABELS, labelSet("status:planned", "status:triaged")],
			[ADD, okOut("[]")],
			[REMOVE, okOut("[]")],
		]);
		const add = calls.findIndex((line) => /--method POST .*labels/.test(line));
		const remove = calls.findIndex((line) => /--method DELETE .*labels/.test(line));
		expect(add).toBeGreaterThanOrEqual(0);
		expect(remove).toBeGreaterThan(add);
	});

	/**
	 * The flip re-derives the floor itself rather than trusting any caller's reading of `plan check`'s
	 * exit code. Delete the re-gate and a defective plan flips straight into the build pool.
	 */
	it("refuses 20 on a defective floor, and writes nothing", async () => {
		const defective = child({
			number: 4301,
			labels: ["type:feature", "p1", "status:planned"],
			body: childBody({criteria: "no boxes"}),
		});
		const digest = await digestOf([
			[EPIC, ONE_CHILD_EPIC],
			[SUBS, subIssues(4301)],
			[CHILD, defective],
			[CYCLE, okOut("{}")],
		]);
		const {outcome, calls} = await run(digest, [
			...CLAIMED,
			...ledger(defective, defective),
			[LABELS, labelSet("status:planned", "status:triaged")],
		]);
		expect(outcome.code).toBe(FLOOR_DEFECTIVE);
		expect(outcome.stdout).toBe("");
		expect(calls.some((line) => /--method (POST|DELETE) .*labels/.test(line))).toBe(false);
	});

	/** The TOCTOU answer: the gap between deciding and writing is closed by re-deciding. */
	it("refuses 21 when the recomputed digest differs from --digest", async () => {
		const {outcome, calls} = await run("000000000000", [
			...CLAIMED,
			...ledger(PLANNED, TRIAGED),
			[LABELS, labelSet("status:planned", "status:triaged")],
		]);
		expect(outcome.code).toBe(PLAN_MOVED);
		expect(outcome.stderr.at(-1)).toContain("the plan moved since the check");
		expect(calls.some((line) => /--method (POST|DELETE) .*labels/.test(line))).toBe(false);
	});

	/**
	 * `POST .../labels` creates an unknown label rather than rejecting it (#4285), so an absent label
	 * would be silently minted. Drop the precondition and the write below invents `status:triaged`.
	 */
	it("refuses 23 when a label it must write is absent from the taxonomy", async () => {
		const digest = await digestOf(CLEAN_READ);
		const {outcome, calls} = await run(digest, [
			...CLAIMED,
			...ledger(PLANNED, TRIAGED),
			[LABELS, labelSet("status:planned", "type:feature")],
		]);
		expect(outcome.code).toBe(LABEL_ABSENT);
		expect(outcome.stderr.at(-1)).toContain('label "status:triaged" is absent');
		expect(calls.some((line) => /--method POST .*labels/.test(line))).toBe(false);
	});

	it("skips the vocabulary check when there is nothing to flip", async () => {
		const already = child({number: 4301, labels: ["type:feature", "p1", "status:triaged"]});
		const digest = await digestOf([
			[EPIC, ONE_CHILD_EPIC],
			[SUBS, subIssues(4301)],
			[CHILD, already],
			[CYCLE, okOut("{}")],
		]);
		const {outcome, calls} = await run(digest, [...CLAIMED, ...ledger(already, already)]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			terminal: "nothing-to-flip",
			flipped: 0,
			already: 1,
		});
		expect(calls.some((line) => LABELS.test(line))).toBe(false);
	});

	/**
	 * v1 asserted the flip from its pre-mutation intent list and re-read nothing, so a child left
	 * carrying both labels — the ADD landing and the DELETE failing — was reported as pickable.
	 */
	it("refuses 22 when the re-read proves a child did not move", async () => {
		const digest = await digestOf(CLEAN_READ);
		const stuck = child({
			number: 4301,
			labels: ["type:feature", "p1", "status:planned", "status:triaged"],
		});
		const {outcome} = await run(digest, [
			...CLAIMED,
			...ledger(PLANNED, stuck),
			[LABELS, labelSet("status:planned", "status:triaged")],
			[ADD, okOut("[]")],
			[REMOVE, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(outcome.code).toBe(PARTIAL_FLIP);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.at(-1)).toContain("1 unchanged (#4301) — the epic is half-flipped");
	});

	it("refuses 8 when a write landed and no re-read can prove its outcome", async () => {
		const digest = await digestOf(CLEAN_READ);
		const {outcome} = await run(digest, [
			...CLAIMED,
			...ledger(PLANNED, errOut("gh: Bad gateway (HTTP 502)")),
			[LABELS, labelSet("status:planned", "status:triaged")],
			[ADD, okOut("[]")],
			[REMOVE, okOut("[]")],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("the outcome is UNKNOWN");
	});

	it("refuses 15 when this session does not hold the epic's claim", async () => {
		const {outcome, calls} = await run("4d90e1bb27ac", [
			[EPIC, ONE_CHILD_EPIC],
			[COMMENTS, comments({id: 1, body: marker("another-session", LANE_UUID)})],
			[PERM, okOut("write\n")],
		]);
		expect(outcome.code).toBe(CLAIM_NOT_MINE);
		expect(calls.some((line) => /--method/.test(line))).toBe(false);
	});

	it("refuses 10 on a --digest that is not 12 lowercase hex, before any read", async () => {
		const {outcome, calls} = await run("NOTHEX", []);
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toContain("--digest must be 12 lowercase hex");
		expect(calls).toEqual([]);
	});
});
