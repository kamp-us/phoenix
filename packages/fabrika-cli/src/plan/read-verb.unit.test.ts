import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut} from "../fakes.test-support.ts";
import {BAD_SECTIONS, OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {
	CHILD,
	CWD,
	CYCLE_DOC,
	child,
	childBody,
	cycleDoc,
	ENV,
	epic,
	epicBody,
	labelSet,
	planSeams,
	type Scripted,
	SUB_ISSUES,
	subIssues,
} from "./fixtures.test-support.ts";
import {runRead} from "./read-verb.ts";

const EPIC = /^gh api repos\/o\/r\/issues\/4300$/;
const SUBS = SUB_ISSUES;
const CHILD_1 = CHILD(4301);
const CHILD_2 = CHILD(4302);
const CYCLE = CYCLE_DOC;

const options = {number: 4300, repo: null, env: ENV, cwd: CWD};

const run = (script: ReadonlyArray<Scripted>) =>
	Effect.runPromise(Effect.provide(runRead(options), planSeams(script).layer));

const CLEAN: ReadonlyArray<Scripted> = [
	[EPIC, epic()],
	[SUBS, subIssues(4301, 4302)],
	[CHILD_1, child({number: 4301})],
	[CHILD_2, child({number: 4302, body: childBody({stories: "2"})})],
	[CYCLE, cycleDoc],
];

describe("runRead", () => {
	it("prints the ledger as one object, with the topology and the digest", async () => {
		const out = await run(CLEAN);
		expect(out.code).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer.answer).toBe("read");
		expect(answer.epic).toBe(4300);
		expect(answer.epicStories).toEqual([1, 2]);
		expect(answer.cycleDoc).toBe("present");
		expect(answer.topology).toEqual({phases: [["#4301", "#4302"]], edges: []});
		expect(answer.digest).toMatch(/^[0-9a-f]{12}$/);
		expect(answer.children.map((c: {number: number}) => c.number)).toEqual([4301, 4302]);
	});

	it("names the scanned set on stderr, count first", async () => {
		const out = await run(CLEAN);
		expect(out.stderr).toContain("plan read: scanned 2 children; #4301, #4302.");
	});

	/**
	 * The three-state slot: `assigneesObserved: false` and `assignees: null` mean the payload carried
	 * no `assignees` key at all. Default the field to `[]` in `toChildPayload` and this reds — and in
	 * the field `UNVERIFIABLE_ASSIGNEE` silently becomes unreachable.
	 */
	it("carries an unobserved assignee slot apart from an observed-empty one", async () => {
		const out = await run([
			[EPIC, epic()],
			[SUBS, subIssues(4301, 4302)],
			[CHILD_1, child({number: 4301, assignees: null})],
			[CHILD_2, child({number: 4302, assignees: ["rmoreno"]})],
			[CYCLE, cycleDoc],
		]);
		const [first, second] = JSON.parse(out.stdout).children;
		expect(first).toMatchObject({assignees: null, assigneesObserved: false});
		expect(second).toMatchObject({assignees: ["rmoreno"], assigneesObserved: true});
	});

	it("refuses zero sub-issue children on 7, with nothing on stdout (ADR 0092)", async () => {
		const out = await run([
			[EPIC, epic()],
			[SUBS, subIssues()],
		]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("has zero sub-issue children");
	});

	it("refuses a non-epic on 10", async () => {
		const out = await run([[EPIC, epic({labels: [{name: "type:feature"}]})]]);
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toContain("is not a type:epic");
	});

	it("refuses a proven-absent epic on 7 and an unreadable one on 11", async () => {
		const absent = await run([[EPIC, errOut("gh: Not Found (HTTP 404)")]]);
		expect(absent.code).toBe(ZERO_SCOPE);
		const unknown = await run([[EPIC, errOut("gh: Bad gateway (HTTP 502)")]]);
		expect(unknown.code).toBe(PRECONDITION_UNKNOWN);
	});

	describe("the ledger grammar refuses on 4", () => {
		it("a section declared twice", async () => {
			const out = await run([
				[EPIC, epic({body: `${epicBody()}\n## Dependencies\n\n- phase 2: #4302\n`})],
			]);
			expect(out.code).toBe(BAD_SECTIONS);
			expect(out.stderr.at(-1)).toContain('carries 2 "## Dependencies" sections');
		});

		it("an unparseable dependencies block", async () => {
			const out = await run([
				[EPIC, epic({body: epicBody({dependencies: "- whenever #4301 feels ready"})})],
			]);
			expect(out.code).toBe(BAD_SECTIONS);
			expect(out.stderr.at(-1)).toContain("is unparseable at line");
		});

		it("a non-empty story list that is not contiguous from 1", async () => {
			const out = await run([[EPIC, epic({body: epicBody({stories: "1. one\n3. three"})})]]);
			expect(out.code).toBe(BAD_SECTIONS);
			expect(out.stderr.at(-1)).toContain("must run from 1 with no gaps or repeats");
		});

		it("a child field line declared twice", async () => {
			const twice = `${childBody()}\n**Stories:** 2\n`;
			const out = await run([
				[EPIC, epic()],
				[SUBS, subIssues(4301)],
				[CHILD_1, child({number: 4301, body: twice})],
			]);
			expect(out.code).toBe(BAD_SECTIONS);
			expect(out.stderr.at(-1)).toContain('carries 2 "**Stories:**" lines');
		});
	});

	it("refuses an unreadable child on 11 — never an empty ledger", async () => {
		const out = await run([
			[EPIC, epic()],
			[SUBS, subIssues(4301)],
			[CHILD_1, {status: 502, body: '{"message":"Bad gateway"}'}],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	/**
	 * A sub-issue list that decodes to something else is a failure, never "this epic has no children"
	 * — which would turn a broken read into a clean `7` about a real ledger.
	 */
	it("refuses a sub-issue list of the wrong shape on 11", async () => {
		const out = await run([
			[EPIC, epic()],
			[SUBS, {status: 200, body: '[{"id": 1}]'}],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	describe("the cycle-doc probe is three-valued", () => {
		it.each([
			["present", cycleDoc],
			["absent", {status: 404, body: '{"message":"Not Found"}'}],
			["unknown", {status: 502, body: '{"message":"Bad gateway"}'}],
		] as const)("reads %s", async (expected, response) => {
			const out = await run([
				[EPIC, epic()],
				[SUBS, subIssues(4301)],
				[CHILD_1, child({number: 4301})],
				[CYCLE, response],
			]);
			expect(JSON.parse(out.stdout).cycleDoc).toBe(expected);
		});
	});

	it("reads the child fetches at bounded fan-out, one request per child", async () => {
		const seams = planSeams([...CLEAN, [/^gh api --paginate repos\/o\/r\/labels/, labelSet()]]);
		await Effect.runPromise(Effect.provide(runRead(options), seams.layer));
		expect(seams.http.calls.filter((line) => /issues\/430[12]$/.test(line))).toHaveLength(2);
	});
});
