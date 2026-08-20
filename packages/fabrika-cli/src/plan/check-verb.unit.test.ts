import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {comments} from "../build/fixtures.test-support.ts";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {runCheck} from "./check-verb.ts";
import {OFF_VOCABULARY, PLAN_UNAPPROVED, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {
	APPROVER,
	approvalRow,
	CWD,
	child,
	childBody,
	digestOver,
	epic,
	epicBody,
	planContext,
	ROSTER,
	subIssues,
} from "./fixtures.test-support.ts";

const EPIC = /^gh api repos\/o\/r\/issues\/4300$/;
const SUBS = /^gh api --paginate repos\/o\/r\/issues\/4300\/sub_issues/;
const CHILD_1 = /^gh api repos\/o\/r\/issues\/4301$/;
const CHILD_2 = /^gh api repos\/o\/r\/issues\/4302$/;
const REF_9999 = /^gh api repos\/o\/r\/issues\/9999$/;
const CYCLE = /^gh api repos\/o\/r\/contents\/product-development-cycle\.md$/;

const options = {
	number: 4300,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	cwd: CWD,
};

const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4300\/comments/;

/**
 * The floor over an **approved** plan — the arm every case below the approval `describe` is about.
 *
 * The marker has to be minted against the digest this very script derives, so the helper reads it
 * off `plan read` first: an approval is a statement about a scope, and one bound to any other scope
 * is what the precondition exists to refuse.
 */
const approvedContext = async (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	config?: string | {readonly unreadable: true},
) => {
	const digest = await digestOver(script, {config});
	return planContext(
		fakeShell([...script, ...ROSTER, [COMMENTS, comments(approvalRow(digest))]]),
		config,
	);
};

const run = async (script: ReadonlyArray<readonly [RegExp, ExecResult]>) =>
	Effect.runPromise(Effect.provide(runCheck(options), await approvedContext(script)));

/** An epic whose phase line names exactly the one child a single-child script serves. */
const ONE_CHILD_EPIC = epic({body: epicBody({dependencies: "- phase 1: #4301"})});

const CLEAN: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[EPIC, epic()],
	[SUBS, subIssues(4301, 4302)],
	[CHILD_1, child({number: 4301})],
	[CHILD_2, child({number: 4302, body: childBody({stories: "2"})})],
	[CYCLE, okOut("{}")],
];

describe("runCheck", () => {
	it("answers clean on exit 0, with the scanned set and the digest", async () => {
		const out = await run(CLEAN);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "clean",
			epic: 4300,
			scanned: [4301, 4302],
			skipped: [],
			defects: [],
		});
	});

	/**
	 * v1's gate exited `0` on FAIL *and* printed only a `✓`/`✗` glyph, so `run-gate.sh && proceed`
	 * proceeded on a failure. Seat this arm on a non-zero code and the state word stops being the
	 * discriminator — which is the hole the machine channel exists to close.
	 */
	it("answers defective ALSO on exit 0 — the discriminator is the state word", async () => {
		const out = await run([
			[EPIC, ONE_CHILD_EPIC],
			[SUBS, subIssues(4301)],
			[CHILD_1, child({number: 4301, body: childBody({criteria: "no boxes here"})})],
			[CYCLE, okOut("{}")],
		]);
		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer.answer).toBe("defective");
		expect(answer.defects[0]).toMatchObject({type: "ZERO_AC", refs: [4301]});
	});

	it("names the scanned set on BOTH arms, so a clean answer states its scope", async () => {
		const clean = await run(CLEAN);
		expect(clean.stderr[0]).toBe("plan check: scanned 2 children; #4301, #4302.");
		const defective = await run([
			[EPIC, ONE_CHILD_EPIC],
			[SUBS, subIssues(4301)],
			[CHILD_1, child({number: 4301, body: childBody({criteria: "none"})})],
			[CYCLE, okOut("{}")],
		]);
		expect(defective.stderr[0]).toBe("plan check: scanned 1 child; #4301.");
		expect(defective.stderr[1]).toContain("hard defect(s) over 1 child(ren) — see stdout.");
	});

	it("carries `skipped` on the answer when the cycle-doc probe failed", async () => {
		const out = await run([
			[EPIC, epic()],
			[SUBS, subIssues(4301, 4302)],
			[CHILD_1, child({number: 4301})],
			[CHILD_2, child({number: 4302, body: childBody({stories: "2"})})],
			[CYCLE, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "clean",
			skipped: ["MISSING_CONTAINMENT"],
		});
	});

	/**
	 * `DANGLING_DEP` is decided by the probe's HTTP status. Answer the probe with a 5xx instead and the
	 * verb refuses `11` rather than reporting the ref as absent — an unreachable GitHub proves nothing.
	 */
	it("derives DANGLING_DEP from a 404 and refuses 11 on anything else", async () => {
		const referencing = epic({
			body: epicBody({dependencies: "- phase 1: #4301\n- #4301 requires: #9999"}),
		});
		const dangling = await run([
			[EPIC, referencing],
			[SUBS, subIssues(4301)],
			[CHILD_1, child({number: 4301})],
			[REF_9999, errOut("gh: Not Found (HTTP 404)")],
			[CYCLE, okOut("{}")],
		]);
		expect(JSON.parse(dangling.stdout).defects).toContainEqual({
			type: "DANGLING_DEP",
			refs: [9999],
			detail: "#9999 is referenced but is not a child and is proven absent",
		});

		const unreadable = await run([
			[EPIC, referencing],
			[SUBS, subIssues(4301)],
			[CHILD_1, child({number: 4301})],
			[REF_9999, errOut("gh: Bad gateway (HTTP 502)")],
			[CYCLE, okOut("{}")],
		]);
		expect(unreadable.code).toBe(PRECONDITION_UNKNOWN);
		expect(unreadable.stdout).toBe("");
		expect(unreadable.stderr.at(-1)).toContain("the floor is UNKNOWN, not clean");
	});

	it("refuses zero scope on 7 rather than answering `clean` over nothing", async () => {
		const out = await run([
			[EPIC, epic()],
			[SUBS, okOut("[]")],
		]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
	});

	it("refuses a non-epic on 10", async () => {
		const out = await run([[EPIC, epic({labels: [{name: "type:chore"}]})]]);
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toContain("refusing to gate it");
	});

	it("re-runs the fetch itself — it takes no ledger from a caller", async () => {
		const digest = await digestOver(CLEAN);
		const shell = fakeShell([...CLEAN, ...ROSTER, [COMMENTS, comments(approvalRow(digest))]]);
		await Effect.runPromise(Effect.provide(runCheck(options), planContext(shell)));
		expect(shell.calls.some((line) => /sub_issues/.test(line))).toBe(true);
	});
});

/**
 * ADR 0289's fail-closed precondition. It sits **ahead of the floor**, so these cases are about what
 * the verb refuses to grade at all rather than about what it grades.
 */
describe("the approval precondition", () => {
	const unapproved = (script: ReadonlyArray<readonly [RegExp, ExecResult]>, listed: ExecResult) =>
		Effect.runPromise(
			Effect.provide(
				runCheck(options),
				planContext(fakeShell([...script, ...ROSTER, [COMMENTS, listed]])),
			),
		);

	it("refuses 25 when the epic carries no approval marker", async () => {
		const out = await unapproved(CLEAN, comments());
		expect(out.code).toBe(PLAN_UNAPPROVED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("carries no founder approval");
	});

	/**
	 * The whole point of seating this ahead of the floor: a plan nobody read gets no verdict over its
	 * defects, because reporting them would hand a founder who never saw it a reading of it.
	 */
	it("refuses on the approval code, not FLOOR_DEFECTIVE, when the floor is ALSO defective", async () => {
		const out = await unapproved(
			[
				[EPIC, ONE_CHILD_EPIC],
				[SUBS, subIssues(4301)],
				[CHILD_1, child({number: 4301, body: childBody({criteria: "no boxes here"})})],
				[CYCLE, okOut("{}")],
			],
			comments(),
		);
		expect(out.code).toBe(PLAN_UNAPPROVED);
		expect(out.stdout).toBe("");
	});

	it("refuses 25 when the marker's digest names a plan the epic has moved off", async () => {
		const out = await unapproved(CLEAN, comments(approvalRow("0000000000ff", {author: APPROVER})));
		expect(out.code).toBe(PLAN_UNAPPROVED);
		expect(out.stderr.at(-1)).toContain("state stale");
	});

	it("passes through unchanged when the marker binds the derived digest", async () => {
		const out = await run(CLEAN);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "clean", defects: []});
	});

	/** #4223's collapse, on this side too: a roster nobody could read is UNKNOWN, never `absent`. */
	it("refuses 11, not 25, when the roster cannot be read", async () => {
		const out = await Effect.runPromise(
			Effect.provide(
				runCheck(options),
				planContext(
					fakeShell([
						...CLEAN,
						[/^gh api repos\/o\/r --jq \.default_branch$/, errOut("gh: Bad gateway (HTTP 502)")],
					]),
				),
			),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("who may approve is unread");
	});
});

/**
 * Story 1 and story 5 of #5631 together: the bare repo gets phoenix's behaviour off the shipped
 * vocabulary, and a repo that declares its own gets that one instead. Every other test in this file
 * is the bare-repo arm — none of them writes a config — so these two only have to move the config.
 */
describe("the containment vocabulary, resolved", () => {
	const withConfig = async (config: string | {readonly unreadable: true}) =>
		Effect.runPromise(Effect.provide(runCheck(options), await approvedContext(CLEAN, config)));

	it("reds a phoenix-legal marker a foreign vocabulary does not carry", async () => {
		const out = await withConfig(
			'{"containmentVocabulary": {"values": ["unpublished", "exempt"]}}',
		);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "defective",
			defects: expect.arrayContaining([
				expect.objectContaining({
					type: "MISSING_CONTAINMENT",
					detail: "type:feature with containment unset",
				}),
			]),
		});
	});

	it("asks no child for a marker on an empty vocabulary", async () => {
		const unmarked: ReadonlyArray<readonly [RegExp, ExecResult]> = [
			[EPIC, epic()],
			[SUBS, subIssues(4301, 4302)],
			[CHILD_1, child({number: 4301, body: childBody({containment: null})})],
			[CHILD_2, child({number: 4302, body: childBody({stories: "2", containment: null})})],
			[CYCLE, okOut("{}")],
		];
		const off = await Effect.runPromise(
			Effect.provide(
				runCheck(options),
				await approvedContext(unmarked, '{"containmentVocabulary": {"types": []}}'),
			),
		);
		const bare = await run(unmarked);
		expect(JSON.parse(off.stdout).answer).toBe("clean");
		expect(JSON.parse(bare.stdout).defects.map((defect: {type: string}) => defect.type)).toContain(
			"MISSING_CONTAINMENT",
		);
	});

	it("leaves the floor UNKNOWN when the config exists and cannot be read", async () => {
		const out = await withConfig({unreadable: true});
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("the floor is UNKNOWN, not clean");
	});

	it("refuses a config whose vocabulary does not decode", async () => {
		const out = await withConfig('{"containmentVocabulary": {"values": ["none"]}}');
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});
});
