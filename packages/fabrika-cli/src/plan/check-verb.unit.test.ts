import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {runCheck} from "./check-verb.ts";
import {OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {
	CWD,
	child,
	childBody,
	epic,
	epicBody,
	planContext,
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

const run = (script: ReadonlyArray<readonly [RegExp, ExecResult]>) =>
	Effect.runPromise(Effect.provide(runCheck(options), planContext(fakeShell(script))));

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
		const shell = fakeShell(CLEAN);
		await Effect.runPromise(Effect.provide(runCheck(options), planContext(shell)));
		expect(shell.calls.some((line) => /sub_issues/.test(line))).toBe(true);
	});
});

/**
 * Story 1 and story 5 of #5631 together: the bare repo gets phoenix's behaviour off the shipped
 * vocabulary, and a repo that declares its own gets that one instead. Every other test in this file
 * is the bare-repo arm — none of them writes a config — so these two only have to move the config.
 */
describe("the containment vocabulary, resolved", () => {
	const withConfig = (config: string | {readonly unreadable: true}) =>
		Effect.runPromise(Effect.provide(runCheck(options), planContext(fakeShell(CLEAN), config)));

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
				planContext(fakeShell(unmarked), '{"containmentVocabulary": {"types": []}}'),
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
