import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	UNREPAIRABLE,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {runRepairCriteria} from "./repair-criteria-verb.ts";

const READ = /^gh api repos\/o\/r\/issues\/5726$/;
const PATCH = /^gh api --method PATCH repos\/o\/r\/issues\/5726 -f body=/;
const LIST = /^gh api --paginate repos\/o\/r\/issues\?state=open&per_page=100$/;

const ITEMS = "- [ ] one criterion\n- [x] a checked one";
const DRIFTED = `Intro.\n\n## Acceptance criteria\n\n${ITEMS}`;
const REPAIRED = `Intro.\n\n### Acceptance criteria\n\n${ITEMS}`;

const record = (number: number, body: string, extra: Record<string, unknown> = {}) => ({
	number,
	title: "t",
	body,
	state: "open",
	labels: [],
	html_url: `https://example.test/issues/${number}`,
	milestone: null,
	...extra,
});

const issue = (body: string, extra: Record<string, unknown> = {}): ExecResult =>
	okOut(JSON.stringify(record(5726, body, extra)));

const options = {
	issue: 5726 as number | null,
	sweep: false,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(runRepairCriteria({...options, ...overrides}), fakeShell(script).layer),
	);

describe("runRepairCriteria — one issue", () => {
	it("repairs a level-2 drift: PATCH, read-back, then the repaired line", async () => {
		const shell = fakeShell([
			[once(READ), issue(DRIFTED)],
			[PATCH, okOut("{}")],
			[READ, issue(REPAIRED)],
		]);
		const outcome = await Effect.runPromise(
			Effect.provide(runRepairCriteria(options), shell.layer),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("repaired\t5726\n");
		const patched = shell.calls.find((line) => PATCH.test(line));
		expect(patched).toContain("### Acceptance criteria");
		expect(patched).not.toContain("\n## Acceptance criteria");
	});

	it("answers conforming on a level-3 body and writes nothing", async () => {
		const shell = fakeShell([[READ, issue(REPAIRED)]]);
		const outcome = await Effect.runPromise(
			Effect.provide(runRepairCriteria(options), shell.layer),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("conforming\t5726\n");
		expect(shell.calls.some((line) => PATCH.test(line))).toBe(false);
	});

	it("answers no-block on a body with no heading at all, and writes nothing", async () => {
		const shell = fakeShell([[READ, issue("## Summary\n\nJust prose.")]]);
		const outcome = await Effect.runPromise(
			Effect.provide(runRepairCriteria(options), shell.layer),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("no-block\t5726\n");
		expect(shell.calls.some((line) => PATCH.test(line))).toBe(false);
	});

	it("refuses drifted text on 14, naming what it read, and writes nothing", async () => {
		const shell = fakeShell([[READ, issue(`## Acceptance criterias\n\n${ITEMS}`)]]);
		const outcome = await Effect.runPromise(
			Effect.provide(runRepairCriteria(options), shell.layer),
		);
		expect(outcome.code).toBe(UNREPAIRABLE);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.at(-1)).toContain('heading text "Acceptance criterias"');
		expect(shell.calls.some((line) => PATCH.test(line))).toBe(false);
	});

	it("emits the record on stdout with --json", async () => {
		const outcome = await run([[READ, issue(REPAIRED)]], {json: true});
		expect(JSON.parse(outcome.stdout)).toEqual({outcome: "conforming", number: 5726});
	});

	it("refuses an absent issue on 7, an unreadable one on 11", async () => {
		expect((await run([[READ, errOut("gh: Not Found (HTTP 404)")]])).code).toBe(ZERO_SCOPE);
		expect((await run([[READ, errOut("gh: Bad gateway (HTTP 502)")]])).code).toBe(
			PRECONDITION_UNKNOWN,
		);
	});

	it("refuses a pull request and a closed issue on 7 — neither carries a gradeable contract", async () => {
		const pr = await run([[READ, issue(DRIFTED, {pull_request: {url: "x"}})]]);
		expect(pr.code).toBe(ZERO_SCOPE);
		expect(pr.stderr.at(-1)).toContain("pull request");
		const closed = await run([[READ, issue(DRIFTED, {state: "closed"})]]);
		expect(closed.code).toBe(ZERO_SCOPE);
	});

	it("reports a failed PATCH as UNKNOWN on 8, and a read-back mismatch on 9", async () => {
		const failed = await run([
			[READ, issue(DRIFTED)],
			[PATCH, errOut("gh: timeout")],
		]);
		expect(failed.code).toBe(WRITE_UNKNOWN);
		expect(failed.stderr.at(-1)).toContain("UNKNOWN whether the body changed");
		const mismatched = await run([
			[once(READ), issue(DRIFTED)],
			[PATCH, okOut("{}")],
			[READ, issue("something else entirely")],
		]);
		expect(mismatched.code).toBe(READBACK_MISMATCH);
	});

	it("refuses usage that names neither or both targets, before reading anything", async () => {
		expect((await run([], {issue: null, sweep: false})).code).toBe(1);
		expect((await run([], {issue: 5726, sweep: true})).code).toBe(1);
	});
});

describe("runRepairCriteria — the sweep", () => {
	const board = okOut(
		JSON.stringify([
			record(3, "## Summary\n\nno block here"),
			record(2, REPAIRED),
			record(1, DRIFTED.replace("Intro.", "First.")),
			record(4, `## Acceptance criterias\n\n${ITEMS}`),
			record(9, DRIFTED, {pull_request: {url: "x"}}),
		]),
	);
	const PATCH_1 = /^gh api --method PATCH repos\/o\/r\/issues\/1 -f body=/;
	const READ_1 = /^gh api repos\/o\/r\/issues\/1$/;

	it("repairs every drifted open issue and prints one outcome line per issue, ascending", async () => {
		const shell = fakeShell([
			[LIST, board],
			[PATCH_1, okOut("{}")],
			[READ_1, okOut(JSON.stringify(record(1, REPAIRED.replace("Intro.", "First."))))],
		]);
		const outcome = await Effect.runPromise(
			Effect.provide(runRepairCriteria({...options, issue: null, sweep: true}), shell.layer),
		);
		expect(outcome.code).toBe(0);
		const [summary, ...lines] = outcome.stdout.trimEnd().split("\n");
		expect(summary).toBe("swept\t1\t1\t1\t1");
		expect(lines[0]).toBe("repaired\t1");
		expect(lines[1]).toBe("conforming\t2");
		expect(lines[2]).toBe("no-block\t3");
		expect(lines[3]?.startsWith("refused\t4\t")).toBe(true);
		// The pull request never appears: it is filtered out of the board, not swept and refused.
		expect(lines).toHaveLength(4);
		expect(outcome.stderr.some((line) => line.includes("scanned 4 open issues"))).toBe(true);
	});

	it("stops on a failed write with the progress so far on stderr, never a silent partial sweep", async () => {
		const outcome = await run(
			[
				[LIST, board],
				[PATCH_1, errOut("gh: timeout")],
			],
			{issue: null, sweep: true},
		);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stdout).toBe("");
	});

	it("refuses an unreadable board on 11 — a sweep over unknown scope proves nothing", async () => {
		const outcome = await run([[LIST, errOut("gh: Bad gateway (HTTP 502)")]], {
			issue: null,
			sweep: true,
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("could not be read");
	});
});
