/**
 * `guard homing-guard check` over a scripted `gh` — the two scopes, and every read failure that has
 * to land as UNKNOWN rather than as a clean or a red.
 *
 * The scoping reads are asserted by the command lines the verb spawns: the sweep must narrow at the
 * endpoint, and the label-set read must happen only on the fork that needs it (#4272).
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {FAILED} from "../verb.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {runHomingGuard} from "./homing-verb.ts";

const BACKLOG = /^gh api --paginate repos\/o\/r\/issues\?state=open&labels=status%3Atriaged/;
const ONE = /^gh api repos\/o\/r\/issues\/9$/;
const LABELS = /^gh api --paginate repos\/o\/r\/labels/;

const ENV = {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>;

interface IssueShape {
	readonly number: number;
	readonly labels?: ReadonlyArray<string>;
	readonly milestone?: number | null;
	readonly pull?: boolean;
}

const body = (shape: IssueShape) => ({
	number: shape.number,
	title: `issue ${shape.number}`,
	body: "",
	state: "open",
	labels: (shape.labels ?? ["status:triaged"]).map((name) => ({name})),
	html_url: `https://example.test/issues/${shape.number}`,
	milestone: shape.milestone == null ? null : {number: shape.milestone},
	...(shape.pull === true ? {pull_request: {url: "https://example.test/pulls/9"}} : {}),
});

const board = (...shapes: ReadonlyArray<IssueShape>): ExecResult =>
	okOut(JSON.stringify(shapes.map(body)));

const one = (shape: IssueShape): ExecResult => okOut(JSON.stringify(body(shape)));

const labels = (...names: ReadonlyArray<string>): ExecResult => okOut(names.join("\n"));

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	options: {issue?: number; repo?: string | null; env?: Record<string, string | undefined>} = {},
) => {
	const shell = fakeShell(script);
	return Effect.runPromise(
		Effect.provide(
			runHomingGuard({
				issue: options.issue ?? null,
				repo: options.repo ?? null,
				env: options.env ?? ENV,
			}),
			shell.layer,
		),
	).then((outcome) => ({outcome, calls: shell.calls}));
};

describe("runHomingGuard — the backlog sweep", () => {
	it("passes and reports what it scanned when every triaged issue is homed or exempt", async () => {
		const {outcome, calls} = await run([
			[
				BACKLOG,
				board(
					{number: 1, milestone: 17},
					{number: 2, labels: ["status:triaged", "wayfinder:backlog"]},
				),
			],
		]);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("scanned 2 triaged issue(s)");
		expect(outcome.stdout).toContain("1 milestone-homed");
		expect(calls).toHaveLength(1);
	});

	it("narrows at the endpoint rather than paging the whole open board", async () => {
		const {calls} = await run([[BACKLOG, board({number: 1, milestone: 17})]]);
		expect(calls[0]).toContain("labels=status%3Atriaged");
		expect(calls[0]).toContain("state=open");
	});

	it("reds 12 on an un-homed issue and prints the three home-or-exempt-or-kill outcomes", async () => {
		const {outcome} = await run([[BACKLOG, board({number: 1, milestone: 17}, {number: 2})]]);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		const report = outcome.stderr.join("\n");
		expect(report).toContain("#2 issue 2");
		expect(report).toContain("home it in an EXISTING open arc/campaign milestone");
		expect(report).toContain("kill it (close not-planned)");
	});

	it("reds 12 on a double-marked issue, naming the exactly-one mark to drop", async () => {
		const {outcome} = await run([
			[BACKLOG, board({number: 2, milestone: 24, labels: ["status:triaged", "wayfinder:backlog"]})],
		]);
		expect(outcome.code).toBe(VIOLATION);
		const report = outcome.stderr.join("\n");
		expect(report).toContain("#2 issue 2 — milestone 24 + wayfinder:backlog");
		expect(report).toContain("drop the MILESTONE");
		expect(report).toContain("drop the STANDING-LANE LABEL");
	});

	it("reds 7 on an empty sweep — a vacuous pass would hide every floater (ADR 0092)", async () => {
		const {outcome} = await run([[BACKLOG, okOut("[]")]]);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("ZERO status:triaged issues");
	});

	it("reds 11 when the board cannot be read — never clean, never a violation", async () => {
		const {outcome} = await run([[BACKLOG, errOut("gh: Bad gateway (HTTP 502)")]]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("emits a ::error annotation for every refusal under Actions", async () => {
		const {outcome} = await run([[BACKLOG, okOut("[]")]], {
			env: {...ENV, GITHUB_ACTIONS: "true"},
		});
		expect(outcome.stderr.some((line) => line.startsWith("::error"))).toBe(true);
	});
});

describe("runHomingGuard — the --issue seam", () => {
	it("scans just that issue and reds it when it left triage un-homed", async () => {
		const {outcome, calls} = await run([[ONE, one({number: 9})]], {issue: 9});
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("#9 issue 9");
		expect(calls).toEqual(["gh api repos/o/r/issues/9"]);
	});

	it("passes a triaged, milestone-homed issue", async () => {
		const {outcome} = await run([[ONE, one({number: 9, milestone: 17})]], {issue: 9});
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("issue #9 is fully homed");
	});

	it("passes an issue that is simply not triaged — a scan of one, never zero scope", async () => {
		const {outcome} = await run(
			[
				[ONE, one({number: 9, labels: ["type:chore"]})],
				[LABELS, labels("status:triaged", "type:chore")],
			],
			{issue: 9},
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("issue #9 is not status:triaged");
	});

	it("reds 11 on that same empty scan when the repo never defined the label (#4272)", async () => {
		const {outcome} = await run(
			[
				[ONE, one({number: 9, labels: ["type:chore"]})],
				[LABELS, labels("type:chore")],
			],
			{issue: 9},
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("do not exist in this repo at all: status:triaged");
	});

	it("reds 11 when the label set itself cannot be read", async () => {
		const {outcome} = await run(
			[
				[ONE, one({number: 9, labels: ["type:chore"]})],
				[LABELS, errOut("gh: Bad gateway (HTTP 502)")],
			],
			{issue: 9},
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("skips the label read entirely when the issue carries the label", async () => {
		const {calls} = await run([[ONE, one({number: 9, milestone: 17})]], {issue: 9});
		expect(calls.some((line) => LABELS.test(line))).toBe(false);
	});

	it("reds 11 on an issue that does not exist", async () => {
		const {outcome} = await run([[ONE, errOut("gh: Not Found (HTTP 404)")]], {issue: 9});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("does not exist");
	});

	it("reds 11 rather than reading a pull request as an un-homed issue (#5562)", async () => {
		const {outcome} = await run([[ONE, one({number: 9, pull: true})]], {issue: 9});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("pull request");
	});

	it("refuses a non-positive issue number as usage, before any read", async () => {
		const {outcome, calls} = await run([], {issue: 0});
		expect(outcome.code).toBe(FAILED);
		expect(calls).toEqual([]);
	});
});

describe("runHomingGuard — the repo", () => {
	it("reds 11 when no target repo resolves", async () => {
		const {outcome} = await run([[/^git remote/, errOut("not a repo")]], {env: {}});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("cannot resolve a target repo");
	});

	it("honours an explicit --repo over the environment", async () => {
		const {calls} = await run([[/^gh api --paginate repos\/other\/x\/issues/, okOut("[]")]], {
			repo: "other/x",
		});
		expect(calls[0]).toContain("repos/other/x/issues");
	});
});
