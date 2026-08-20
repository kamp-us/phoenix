import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import {
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	UNREPAIRABLE,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {runRepairCriteria} from "./repair-criteria-verb.ts";

const READ = /GET .*\/repos\/o\/r\/issues\/5726$/;
const PATCH = /PATCH .*\/repos\/o\/r\/issues\/5726$/;
const LIST = /GET .*\/repos\/o\/r\/issues\?state=open/;
const COMMENT = /POST .*\/repos\/o\/r\/issues\/5726\/comments$/;
const COMMENTED: HttpReply = {status: 201, body: '{"id":1,"html_url":"https://example.test/c/1"}'};

const ACCEPTED: HttpReply = {status: 200, body: "{}"};
const NOT_FOUND: HttpReply = {status: 404, body: '{"message":"Not Found"}'};
const UNREADABLE: HttpReply = {status: 502, body: "{}"};
const WRITE_FAILED: HttpReply = {status: 500, body: "{}"};

const served = (value: unknown): HttpReply => ({status: 200, body: JSON.stringify(value)});

/** What one matching request carried as its JSON body — where the text now travels. */
const bodyFor = (seams: ReturnType<typeof fakeSeams>, pattern: RegExp): string => {
	const at = seams.requests.findIndex((line) => pattern.test(line));
	return at < 0 ? "" : (seams.bodies[at] ?? "");
};

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

const issue = (body: string, extra: Record<string, unknown> = {}): HttpReply =>
	served(record(5726, body, extra));

const options = {
	issue: 5726 as number | null,
	sweep: false,
	dryRun: false,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(
		Effect.provide(runRepairCriteria({...options, ...overrides}), fakeSeams(script).layer),
	);

describe("runRepairCriteria — one issue", () => {
	it("repairs a level-2 drift: PATCH, read-back, then the repaired line", async () => {
		const shell = fakeSeams([
			[once(READ), issue(DRIFTED)],
			[PATCH, ACCEPTED],
			[READ, issue(REPAIRED)],
			[COMMENT, COMMENTED],
		]);
		const outcome = await Effect.runPromise(
			Effect.provide(runRepairCriteria(options), shell.layer),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("repaired\t5726\n");
		const patched = bodyFor(shell, PATCH);
		expect(patched).toContain("### Acceptance criteria");
		expect(patched).not.toContain("\\n## Acceptance criteria");
		expect(bodyFor(shell, COMMENT)).toContain("level 2 → 3");
	});

	it("converts plain bullets under a conforming heading and PATCHes the checkboxes (#6001)", async () => {
		const bullets = "### Acceptance criteria\n\n- one criterion\n- a second";
		const shell = fakeSeams([
			[once(READ), issue(bullets)],
			[PATCH, ACCEPTED],
			[READ, issue("### Acceptance criteria\n\n- [ ] one criterion\n- [ ] a second")],
			[COMMENT, COMMENTED],
		]);
		const outcome = await Effect.runPromise(
			Effect.provide(runRepairCriteria(options), shell.layer),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("repaired\t5726\n");
		expect(bodyFor(shell, PATCH)).toContain("- [ ] one criterion");
	});

	it("answers conforming on a level-3 body and writes nothing", async () => {
		const shell = fakeSeams([[READ, issue(REPAIRED)]]);
		const outcome = await Effect.runPromise(
			Effect.provide(runRepairCriteria(options), shell.layer),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("conforming\t5726\n");
		expect(shell.requests.some((line) => PATCH.test(line))).toBe(false);
	});

	it("answers no-block on a body with no heading at all, and writes nothing", async () => {
		const shell = fakeSeams([[READ, issue("## Summary\n\nJust prose.")]]);
		const outcome = await Effect.runPromise(
			Effect.provide(runRepairCriteria(options), shell.layer),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("no-block\t5726\n");
		expect(shell.requests.some((line) => PATCH.test(line))).toBe(false);
	});

	it("refuses drifted text on 14, naming what it read, and writes nothing", async () => {
		const shell = fakeSeams([[READ, issue(`## Acceptance criterias\n\n${ITEMS}`)]]);
		const outcome = await Effect.runPromise(
			Effect.provide(runRepairCriteria(options), shell.layer),
		);
		expect(outcome.code).toBe(UNREPAIRABLE);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.at(-1)).toContain('heading text "Acceptance criterias"');
		expect(shell.requests.some((line) => PATCH.test(line))).toBe(false);
	});

	it("emits the record on stdout with --json", async () => {
		const outcome = await run([[READ, issue(REPAIRED)]], {json: true});
		expect(JSON.parse(outcome.stdout)).toEqual({outcome: "conforming", number: 5726});
	});

	it("refuses an absent issue on 7, an unreadable one on 11", async () => {
		expect((await run([[READ, NOT_FOUND]])).code).toBe(ZERO_SCOPE);
		expect((await run([[READ, UNREADABLE]])).code).toBe(PRECONDITION_UNKNOWN);
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
			[PATCH, WRITE_FAILED],
		]);
		expect(failed.code).toBe(WRITE_UNKNOWN);
		expect(failed.stderr.at(-1)).toContain("UNKNOWN whether the body changed");
		const mismatched = await run([
			[once(READ), issue(DRIFTED)],
			[PATCH, ACCEPTED],
			[READ, issue("something else entirely")],
		]);
		expect(mismatched.code).toBe(READBACK_MISMATCH);
	});

	it("reports a failed disclosure comment on 8 — an in-place edit with no record of it", async () => {
		const outcome = await run([
			[once(READ), issue(DRIFTED)],
			[PATCH, ACCEPTED],
			[READ, issue(REPAIRED)],
			[COMMENT, WRITE_FAILED],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("nothing recording it");
	});

	it("answers would-repair under --dry-run: the plan on stdout, no PATCH and no comment", async () => {
		const shell = fakeSeams([[READ, issue(DRIFTED)]]);
		const outcome = await Effect.runPromise(
			Effect.provide(runRepairCriteria({...options, dryRun: true}), shell.layer),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("would-repair\t5726\n");
		expect(outcome.stderr.at(-1)).toContain("level 2 → 3");
		expect(shell.requests.some((line) => PATCH.test(line) || COMMENT.test(line))).toBe(false);
	});

	it("refuses usage that names neither or both targets, before reading anything", async () => {
		expect((await run([], {issue: null, sweep: false})).code).toBe(1);
		expect((await run([], {issue: 5726, sweep: true})).code).toBe(1);
	});
});

describe("runRepairCriteria — the sweep", () => {
	const board = served([
		record(3, "## Summary\n\nno block here"),
		record(2, REPAIRED),
		record(1, DRIFTED.replace("Intro.", "First.")),
		record(4, `## Acceptance criterias\n\n${ITEMS}`),
		record(9, DRIFTED, {pull_request: {url: "x"}}),
	]);
	const PATCH_1 = /PATCH .*\/repos\/o\/r\/issues\/1$/;
	const READ_1 = /GET .*\/repos\/o\/r\/issues\/1$/;
	const COMMENT_1 = /POST .*\/repos\/o\/r\/issues\/1\/comments$/;

	it("repairs every drifted open issue and prints one outcome line per issue, ascending", async () => {
		const shell = fakeSeams([
			[LIST, board],
			[once(READ_1), served(record(1, DRIFTED.replace("Intro.", "First.")))],
			[PATCH_1, ACCEPTED],
			[READ_1, served(record(1, REPAIRED.replace("Intro.", "First.")))],
			[COMMENT_1, COMMENTED],
		]);
		const outcome = await Effect.runPromise(
			Effect.provide(runRepairCriteria({...options, issue: null, sweep: true}), shell.layer),
		);
		expect(outcome.code).toBe(0);
		const [summary, ...lines] = outcome.stdout.trimEnd().split("\n");
		expect(summary).toBe("swept\t1\t1\t1\t1\t0\t0");
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
				[once(READ_1), served(record(1, DRIFTED.replace("Intro.", "First.")))],
				[PATCH_1, WRITE_FAILED],
			],
			{issue: null, sweep: true},
		);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stdout).toBe("");
	});

	it("answers moved and writes nothing when the body changed after the board snapshot", async () => {
		const shell = fakeSeams([
			[LIST, board],
			[READ_1, served(record(1, "somebody rewrote this body mid-sweep"))],
		]);
		const outcome = await Effect.runPromise(
			Effect.provide(runRepairCriteria({...options, issue: null, sweep: true}), shell.layer),
		);
		expect(outcome.code).toBe(0);
		expect(shell.requests.some((line) => PATCH_1.test(line))).toBe(false);
		const [summary, ...lines] = outcome.stdout.trimEnd().split("\n");
		expect(summary).toBe("swept\t0\t1\t1\t1\t1\t0");
		expect(lines[0]).toBe(
			"moved\t1\tthe body changed after the board snapshot — re-run the sweep to repair it against its current body",
		);
	});

	it("--dry-run prints the exact set it would touch and issues no re-read, PATCH or comment", async () => {
		const shell = fakeSeams([[LIST, board]]);
		const outcome = await Effect.runPromise(
			Effect.provide(
				runRepairCriteria({...options, issue: null, sweep: true, dryRun: true}),
				shell.layer,
			),
		);
		expect(outcome.code).toBe(0);
		const [summary, ...lines] = outcome.stdout.trimEnd().split("\n");
		expect(summary).toBe("swept\t0\t1\t1\t1\t0\t1");
		expect(lines[0]).toBe("would-repair\t1\tline 3: level 2 → 3");
		expect(
			shell.requests.some(
				(line) => PATCH_1.test(line) || READ_1.test(line) || COMMENT_1.test(line),
			),
		).toBe(false);
	});

	it("answers moved when the issue left the open board between the snapshot and its write", async () => {
		const shell = fakeSeams([
			[LIST, board],
			[READ_1, NOT_FOUND],
		]);
		const outcome = await Effect.runPromise(
			Effect.provide(runRepairCriteria({...options, issue: null, sweep: true}), shell.layer),
		);
		expect(outcome.code).toBe(0);
		expect(shell.requests.some((line) => PATCH_1.test(line))).toBe(false);
		expect(outcome.stdout).toContain("moved\t1\tthe issue left the open board mid-sweep");
	});

	it("halts on 11 when an issue cannot be re-read before its write — never writes the stale plan", async () => {
		const shell = fakeSeams([
			[LIST, board],
			[READ_1, UNREADABLE],
		]);
		const outcome = await Effect.runPromise(
			Effect.provide(runRepairCriteria({...options, issue: null, sweep: true}), shell.layer),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(shell.requests.some((line) => PATCH_1.test(line))).toBe(false);
		expect(outcome.stderr.at(-1)).toContain("cannot re-read #1 before writing it");
	});

	it("refuses an unreadable board on 11 — a sweep over unknown scope proves nothing", async () => {
		const outcome = await run([[LIST, UNREADABLE]], {
			issue: null,
			sweep: true,
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("could not be read");
	});
});
