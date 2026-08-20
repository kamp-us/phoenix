import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {comments, LANE_UUID, marker, LANE_TOKEN as TOKEN} from "../build/fixtures.test-support.ts";
import {errOut, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	CLAIM_NOT_MINE,
	FLOOR_DEFECTIVE,
	LABEL_ABSENT,
	OFF_VOCABULARY,
	PARTIAL_FLIP,
	PLAN_MOVED,
	PLAN_UNAPPROVED,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {
	approvalRow,
	CWD,
	child,
	childBody,
	digestOver,
	epic,
	epicBody,
	labelSet,
	planContext,
	ROSTER,
	SESSION,
	subIssues,
} from "./fixtures.test-support.ts";
import {childrenEvidence, runFlip} from "./flip-verb.ts";

const EPIC = /^gh api repos\/o\/r\/issues\/4300$/;
const SUBS = /^gh api --paginate repos\/o\/r\/issues\/4300\/sub_issues/;
const CHILD = /^gh api repos\/o\/r\/issues\/4301$/;
const CYCLE = /^gh api repos\/o\/r\/contents\/product-development-cycle\.md$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4300\/comments/;
const PERM = /^gh api repos\/o\/r\/collaborators\/agent\/permission/;
const LABELS = /^gh api --paginate repos\/o\/r\/labels/;
const ADD = /^gh api --method POST repos\/o\/r\/issues\/4301\/labels/;
const REMOVE = /^gh api --method DELETE repos\/o\/r\/issues\/4301\/labels/;
const ADD_EPIC = /^gh api --method POST repos\/o\/r\/issues\/4300\/labels/;
const REMOVE_EPIC = /^gh api --method DELETE repos\/o\/r\/issues\/4300\/labels/;

const oneChildEpic = (labels: ReadonlyArray<string>): ExecResult =>
	epic({
		body: epicBody({dependencies: "- phase 1: #4301"}),
		labels: labels.map((name) => ({name})),
	});

const ONE_CHILD_EPIC = oneChildEpic(["type:epic", "ready-for:human"]);
/** The epic as the read-back finds it once the audience flip landed. */
const AGENT_EPIC = oneChildEpic(["type:epic", "ready-for:agent"]);

const env = {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: SESSION} as Record<
	string,
	string | undefined
>;

/**
 * The epic's comments as a lane that may flip finds them: this lane's claim marker, and a standing
 * founder approval of the plan the script derives. Both come off **one** read, so the approval has to
 * be a row here rather than a second scripted `COMMENTS` entry nothing would reach.
 */
const claimed = (digest: string): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[COMMENTS, comments({id: 1, body: marker(SESSION, LANE_UUID)}, approvalRow(digest))],
	[PERM, okOut("write\n")],
	...ROSTER,
];

const PLANNED = child({number: 4301, labels: ["type:feature", "p1", "status:planned"]});
const TRIAGED = child({number: 4301, labels: ["type:feature", "p1", "status:triaged"]});

/** The ledger reads, in the order the flip issues them; `once` lets each re-read differ. */
const ledger = (
	first: ExecResult,
	reread: ExecResult,
	epics: {first?: ExecResult; reread?: ExecResult} = {},
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[once(EPIC), epics.first ?? ONE_CHILD_EPIC],
	[SUBS, subIssues(4301)],
	[once(CHILD), first],
	[CYCLE, okOut("{}")],
	[CHILD, reread],
	[EPIC, epics.reread ?? AGENT_EPIC],
];

const digestOf = (script: ReadonlyArray<readonly [RegExp, ExecResult]>): Promise<string> =>
	digestOver(script);

const CLEAN_READ: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[EPIC, ONE_CHILD_EPIC],
	[SUBS, subIssues(4301)],
	[CHILD, PLANNED],
	[CYCLE, okOut("{}")],
];

const run = (digest: string, script: ReadonlyArray<readonly [RegExp, ExecResult]>) => {
	const shell = fakeShell(script);
	return Effect.runPromise(
		Effect.provide(
			runFlip({number: 4300, digest, token: TOKEN, repo: null, env, cwd: CWD}),
			planContext(shell),
		),
	).then((outcome) => ({outcome, calls: shell.calls}));
};

describe("runFlip", () => {
	it("flips a planned child and reports the OBSERVED results as a count plus histogram", async () => {
		const digest = await digestOf(CLEAN_READ);
		const {outcome} = await run(digest, [
			...claimed(digest),
			...ledger(PLANNED, TRIAGED),
			[LABELS, labelSet("status:planned", "status:triaged", "ready-for:agent", "type:feature")],
			[ADD, okOut("[]")],
			[REMOVE, okOut("[]")],
			[ADD_EPIC, okOut("[]")],
			[REMOVE_EPIC, okOut("[]")],
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			answer: "flipped",
			terminal: "flipped-all",
			flipped: 1,
			already: 0,
			children: {count: 1, results: {flipped: 1}},
			audience: {result: "flipped", observed: ["ready-for:agent", "type:epic"]},
		});
		// `audience.observed` is the answer and stays whole; the child's own observed labels were the
		// evidence, and the collapse is only real if none of them reached stdout (ADR 0308).
		expect(JSON.parse(outcome.stdout).children).toEqual({count: 1, results: {flipped: 1}});
		expect(outcome.stdout).not.toContain("4301");
	});

	/**
	 * The epic is admitted only once every child is *observed* pickable — flip it earlier and a
	 * ledger the re-read proves half-flipped still ships an epic the operator can pick up.
	 */
	it("writes the epic's audience label last, after every child re-read", async () => {
		const digest = await digestOf(CLEAN_READ);
		const {calls} = await run(digest, [
			...claimed(digest),
			...ledger(PLANNED, TRIAGED),
			[LABELS, labelSet("status:planned", "status:triaged", "ready-for:agent")],
			[ADD, okOut("[]")],
			[REMOVE, okOut("[]")],
			[ADD_EPIC, okOut("[]")],
			[REMOVE_EPIC, okOut("[]")],
		]);
		const childReread = calls.findIndex((line) => /^gh api repos\/o\/r\/issues\/4301$/.test(line));
		const epicAdd = calls.findIndex((line) => ADD_EPIC.test(line));
		const epicRemove = calls.findIndex((line) => REMOVE_EPIC.test(line));
		expect(childReread).toBeGreaterThanOrEqual(0);
		expect(epicAdd).toBeGreaterThan(childReread);
		expect(epicRemove).toBeGreaterThan(epicAdd);
	});

	it("refuses 22 when the re-read proves the epic did not reach ready-for:agent", async () => {
		const digest = await digestOf(CLEAN_READ);
		const {outcome} = await run(digest, [
			...claimed(digest),
			...ledger(PLANNED, TRIAGED, {reread: ONE_CHILD_EPIC}),
			[LABELS, labelSet("status:planned", "status:triaged", "ready-for:agent")],
			[ADD, okOut("[]")],
			[REMOVE, okOut("[]")],
			[ADD_EPIC, okOut("[]")],
			[REMOVE_EPIC, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(outcome.code).toBe(PARTIAL_FLIP);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.at(-1)).toContain(
			"epic #4300 does not carry ready-for:agent alone — the epic is half-flipped",
		);
	});

	it("refuses 8 when the epic's audience write cannot be proven", async () => {
		const digest = await digestOf(CLEAN_READ);
		const {outcome} = await run(digest, [
			...claimed(digest),
			...ledger(PLANNED, TRIAGED, {reread: errOut("gh: Bad gateway (HTTP 502)")}),
			[LABELS, labelSet("status:planned", "status:triaged", "ready-for:agent")],
			[ADD, okOut("[]")],
			[REMOVE, okOut("[]")],
			[ADD_EPIC, okOut("[]")],
			[REMOVE_EPIC, okOut("[]")],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("could not re-read the epic #4300");
	});

	it("refuses 23 when ready-for:agent is absent from the taxonomy, writing nothing", async () => {
		const already = child({number: 4301, labels: ["type:feature", "p1", "status:triaged"]});
		const digest = await digestOf([
			[EPIC, ONE_CHILD_EPIC],
			[SUBS, subIssues(4301)],
			[CHILD, already],
			[CYCLE, okOut("{}")],
		]);
		const {outcome, calls} = await run(digest, [
			...claimed(digest),
			...ledger(already, already),
			[LABELS, labelSet("status:planned", "status:triaged", "type:feature")],
		]);
		expect(outcome.code).toBe(LABEL_ABSENT);
		expect(outcome.stderr.at(-1)).toContain('label "ready-for:agent" is absent');
		expect(calls.some((line) => /--method POST .*labels/.test(line))).toBe(false);
	});

	/**
	 * `status:triaged` is added BEFORE `status:planned` is removed, always. Swap the two calls and a
	 * child caught between them carries no `status:` label at all — `MISSING_LABEL` flips true and
	 * `plan verdict` then re-derives a defective floor on a run the gate believes clean.
	 */
	it("adds before it removes", async () => {
		const digest = await digestOf(CLEAN_READ);
		const {calls} = await run(digest, [
			...claimed(digest),
			...ledger(PLANNED, TRIAGED),
			[LABELS, labelSet("status:planned", "status:triaged", "ready-for:agent")],
			[ADD, okOut("[]")],
			[REMOVE, okOut("[]")],
			[ADD_EPIC, okOut("[]")],
			[REMOVE_EPIC, okOut("[]")],
		]);
		const add = calls.findIndex((line) => ADD.test(line));
		const remove = calls.findIndex((line) => REMOVE.test(line));
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
			...claimed(digest),
			...ledger(defective, defective),
			[LABELS, labelSet("status:planned", "status:triaged")],
		]);
		expect(outcome.code).toBe(FLOOR_DEFECTIVE);
		expect(outcome.stdout).toBe("");
		expect(calls.some((line) => /--method (POST|DELETE) .*labels/.test(line))).toBe(false);
	});

	/** The TOCTOU answer: the gap between deciding and writing is closed by re-deciding. */
	it("refuses 21 when the recomputed digest differs from --digest", async () => {
		const digest = await digestOf(CLEAN_READ);
		const {outcome, calls} = await run("000000000000", [
			...claimed(digest),
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
			...claimed(digest),
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
			[EPIC, AGENT_EPIC],
			[SUBS, subIssues(4301)],
			[CHILD, already],
			[CYCLE, okOut("{}")],
		]);
		const {outcome, calls} = await run(digest, [
			...claimed(digest),
			...ledger(already, already, {first: AGENT_EPIC}),
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			terminal: "nothing-to-flip",
			flipped: 0,
			already: 1,
			audience: {result: "already", observed: ["ready-for:agent", "type:epic"]},
		});
		expect(calls.some((line) => LABELS.test(line))).toBe(false);
		expect(calls.some((line) => /--method (POST|DELETE) .*labels/.test(line))).toBe(false);
	});

	/** #5680's shape: an epic planned and gated before #5832, re-gated to earn its audience label. */
	it("flips the epic alone when every child is already triaged", async () => {
		const already = child({number: 4301, labels: ["type:feature", "p1", "status:triaged"]});
		const digest = await digestOf([
			[EPIC, ONE_CHILD_EPIC],
			[SUBS, subIssues(4301)],
			[CHILD, already],
			[CYCLE, okOut("{}")],
		]);
		const {outcome, calls} = await run(digest, [
			...claimed(digest),
			...ledger(already, already),
			[LABELS, labelSet("ready-for:agent")],
			[ADD_EPIC, okOut("[]")],
			[REMOVE_EPIC, okOut("[]")],
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({
			terminal: "flipped-all",
			flipped: 0,
			already: 1,
			audience: {result: "flipped", observed: ["ready-for:agent", "type:epic"]},
		});
		expect(calls.some((line) => ADD.test(line) || REMOVE.test(line))).toBe(false);
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
		const {outcome, calls} = await run(digest, [
			...claimed(digest),
			...ledger(PLANNED, stuck),
			[LABELS, labelSet("status:planned", "status:triaged", "ready-for:agent")],
			[ADD, okOut("[]")],
			[REMOVE, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(outcome.code).toBe(PARTIAL_FLIP);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.at(-1)).toContain("1 unchanged (#4301) — the epic is half-flipped");
		expect(calls.some((line) => ADD_EPIC.test(line))).toBe(false);
	});

	it("refuses 8 when a write landed and no re-read can prove its outcome", async () => {
		const digest = await digestOf(CLEAN_READ);
		const {outcome} = await run(digest, [
			...claimed(digest),
			...ledger(PLANNED, errOut("gh: Bad gateway (HTTP 502)")),
			[LABELS, labelSet("status:planned", "status:triaged", "ready-for:agent")],
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

	/**
	 * The re-gate covers the human decision too: a lane holding a `plan check` that passed before a
	 * re-plan must not carry it past this write (ADR 0289).
	 */
	it("refuses 25 on an unapproved plan, writing nothing", async () => {
		const digest = await digestOf(CLEAN_READ);
		const {outcome, calls} = await run(digest, [
			[COMMENTS, comments({id: 1, body: marker(SESSION, LANE_UUID)})],
			[PERM, okOut("write\n")],
			...ROSTER,
			...ledger(PLANNED, TRIAGED),
			[LABELS, labelSet("status:planned", "status:triaged", "ready-for:agent")],
		]);
		expect(outcome.code).toBe(PLAN_UNAPPROVED);
		expect(outcome.stdout).toBe("");
		expect(calls.some((line) => /--method (POST|DELETE) .*labels/.test(line))).toBe(false);
	});

	it("refuses 25 on a stale approval — a re-plan does not inherit the old one", async () => {
		const digest = await digestOf(CLEAN_READ);
		const {outcome} = await run(digest, [
			[COMMENTS, comments({id: 1, body: marker(SESSION, LANE_UUID)}, approvalRow("0000000000ff"))],
			[PERM, okOut("write\n")],
			...ROSTER,
			...ledger(PLANNED, TRIAGED),
			[LABELS, labelSet("status:planned", "status:triaged", "ready-for:agent")],
		]);
		expect(outcome.code).toBe(PLAN_UNAPPROVED);
		expect(outcome.stderr.at(-1)).toContain("state stale");
	});
});

describe("childrenEvidence", () => {
	it("counts every child and tallies the closed result vocabulary, count-descending", () => {
		expect(
			childrenEvidence([
				{result: "already"},
				{result: "flipped"},
				{result: "already"},
				{result: "not-planned"},
			]),
		).toEqual({count: 4, results: {already: 2, flipped: 1, "not-planned": 1}});
	});

	it("keeps `count` at zero rather than dropping the field, so a caller never reads absence", () => {
		expect(childrenEvidence([])).toEqual({count: 0, results: {}});
	});
});
