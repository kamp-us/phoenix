/**
 * `guard pitch-guard check` over a scripted `gh` — the two scopes, the three-read hydration, and
 * every read failure that has to land as UNKNOWN rather than as a clean or a red.
 *
 * The read ORDER is asserted by the command lines the verb spawns: the sweep narrows at the
 * endpoint, each shortlisted issue is re-read singly for the parent link the list omits, and the ACL
 * is resolved per comment author, fail-closed (ADR 0055).
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {FAILED} from "../verb.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {runPitchGuard} from "./pitch-verb.ts";

const SWEEP = /^gh api --paginate repos\/o\/r\/issues\?state=open&labels=status%3Atriaged/;
const ONE = (n: number) => new RegExp(`^gh api repos/o/r/issues/${n}$`);
const COMMENTS = (n: number) => new RegExp(`^gh api --paginate repos/o/r/issues/${n}/comments`);
const PERM = (login: string) => new RegExp(`^gh api repos/o/r/collaborators/${login}/permission`);
const LABELS = /^gh api --paginate repos\/o\/r\/labels/;

const ENV = {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>;

const PITCH = [
	"## Pitch",
	"",
	"**Problem:** yazars cannot find last week's definition.",
	"**Arc:** sözlük discovery",
	"**Appetite:** 2 cycles",
	"**Rabbit-holes:** full-text ranking",
	"**No-gos:** a second search backend",
].join("\n");

interface IssueShape {
	readonly number: number;
	readonly labels?: ReadonlyArray<string>;
	readonly body?: string;
	readonly parent?: boolean;
	readonly pull?: boolean;
}

const payload = (shape: IssueShape) => ({
	number: shape.number,
	title: `issue ${shape.number}`,
	body: shape.body ?? PITCH,
	state: "open",
	labels: (shape.labels ?? ["status:triaged", "type:feature"]).map((name) => ({name})),
	html_url: `https://example.test/issues/${shape.number}`,
	milestone: null,
	...(shape.parent === true ? {parent_issue_url: "https://api.example.test/issues/1"} : {}),
	...(shape.pull === true ? {pull_request: {url: "https://example.test/pulls/9"}} : {}),
});

const sweep = (...shapes: ReadonlyArray<IssueShape>): ExecResult =>
	okOut(JSON.stringify(shapes.map(payload)));

const one = (shape: IssueShape): ExecResult => okOut(JSON.stringify(payload(shape)));

const comments = (...bodies: ReadonlyArray<{author: string; body: string}>): ExecResult =>
	okOut(
		JSON.stringify(
			bodies.map((entry, index) => ({
				id: index + 1,
				user: {login: entry.author},
				created_at: "2026-08-18T00:00:00Z",
				updated_at: "2026-08-18T00:00:00Z",
				body: entry.body,
			})),
		),
	);

const APPROVED = {
	author: "founder",
	body: "pitch-approved: appetite 2 cycles · 2026-08-18T00:00:00Z",
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	options: {issue?: number; repo?: string | null; env?: Record<string, string | undefined>} = {},
) => {
	const shell = fakeShell(script);
	return Effect.runPromise(
		Effect.provide(
			runPitchGuard({
				issue: options.issue ?? null,
				repo: options.repo ?? null,
				env: options.env ?? ENV,
			}),
			shell.layer,
		),
	).then((outcome) => ({outcome, calls: shell.calls}));
};

describe("runPitchGuard — the backlog sweep", () => {
	it("passes and reports what it scanned when every bet carries an approved pitch", async () => {
		const {outcome} = await run([
			[SWEEP, sweep({number: 11})],
			[ONE(11), one({number: 11})],
			[COMMENTS(11), comments(APPROVED)],
			[PERM("founder"), okOut("admin\n")],
		]);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("scanned 1 lane-entering issue(s)");
	});

	it("narrows at the endpoint, then re-reads each shortlisted issue for its parent link", async () => {
		const {calls} = await run([
			[SWEEP, sweep({number: 11}, {number: 12, labels: ["status:triaged", "type:chore"]})],
			[ONE(11), one({number: 11})],
			[COMMENTS(11), comments(APPROVED)],
			[PERM("founder"), okOut("write\n")],
		]);
		expect(calls[0]).toContain("labels=status%3Atriaged");
		// The chore is filtered before the single read — a non-bet costs no extra call.
		expect(calls).not.toContain("gh api repos/o/r/issues/12");
		expect(calls).toContain("gh api repos/o/r/issues/11");
	});

	it("holds a sub-issue out of scope — it inherits its epic's pitch", async () => {
		const {outcome} = await run([
			[SWEEP, sweep({number: 11})],
			[ONE(11), one({number: 11, parent: true, body: "no pitch here"})],
			[COMMENTS(11), okOut("[]")],
		]);
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("reds 12 on a pickable bet with no pitch, naming it and the draft/approve remedy", async () => {
		const {outcome} = await run([
			[SWEEP, sweep({number: 11})],
			[ONE(11), one({number: 11, body: "no pitch here"})],
			[COMMENTS(11), okOut("[]")],
		]);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		const report = outcome.stderr.join("\n");
		expect(report).toContain("#11 issue 11");
		expect(report).toContain("has no `## Pitch` section");
		expect(report).toContain("the FOUNDER approves it");
	});

	it("refuses an approval from below write+ — an unverifiable one never counts (ADR 0055)", async () => {
		const {outcome} = await run([
			[SWEEP, sweep({number: 11})],
			[ONE(11), one({number: 11})],
			[COMMENTS(11), comments({author: "drive-by", body: "pitch-approved: appetite 2 cycles"})],
			[PERM("drive-by"), okOut("read\n")],
		]);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("not from a write+ collaborator");
	});

	it("resolves an UNREADABLE permission as not authorized rather than erroring the run", async () => {
		const {outcome} = await run([
			[SWEEP, sweep({number: 11})],
			[ONE(11), one({number: 11})],
			[COMMENTS(11), comments(APPROVED)],
			[PERM("founder"), errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("not from a write+ collaborator");
	});

	it("reds 7 on an empty sweep — a vacuous pass would hide every unpitched bet (ADR 0092)", async () => {
		const {outcome} = await run([[SWEEP, okOut("[]")]]);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("ZERO lane-entering issues");
	});

	it("reds 11 when the board cannot be read — never clean, never a violation", async () => {
		const {outcome} = await run([[SWEEP, errOut("gh: Bad gateway (HTTP 502)")]]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("reds 11 when a shortlisted issue's comments cannot be read — part of the set went unread", async () => {
		const {outcome} = await run([
			[SWEEP, sweep({number: 11})],
			[ONE(11), one({number: 11})],
			[COMMENTS(11), errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("went unread");
	});

	it("emits a ::error annotation for every refusal under Actions", async () => {
		const {outcome} = await run([[SWEEP, okOut("[]")]], {
			env: {...ENV, GITHUB_ACTIONS: "true"},
		});
		expect(outcome.stderr.some((line) => line.startsWith("::error"))).toBe(true);
	});
});

describe("runPitchGuard — the --issue seam", () => {
	it("scans just that issue and reds it when it became pickable unpitched", async () => {
		const {outcome, calls} = await run(
			[
				[ONE(9), one({number: 9, body: "no pitch"})],
				[COMMENTS(9), okOut("[]")],
			],
			{issue: 9},
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("#9 issue 9");
		expect(calls).not.toContain(
			"gh api --paginate repos/o/r/issues?state=open&labels=status%3Atriaged&per_page=100",
		);
	});

	it("passes an out-of-scope issue where the scoping labels exist, reading the label set once", async () => {
		const {outcome, calls} = await run(
			[
				[ONE(9), one({number: 9, labels: ["status:triaged", "type:chore"]})],
				[LABELS, okOut("status:triaged\ntype:epic\ntype:feature\n")],
			],
			{issue: 9},
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("not lane-entering work");
		expect(calls.some((call) => call.includes("/labels"))).toBe(true);
	});

	it("reds 11 on an out-of-scope issue in a repo missing the scoping labels (#4272)", async () => {
		const {outcome} = await run(
			[
				[ONE(9), one({number: 9, labels: ["status:triaged", "type:chore"]})],
				[LABELS, okOut("bug\n")],
			],
			{issue: 9},
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("do not exist in this repo");
	});

	it("does not read the label set when the issue IS lane-entering — no ambiguity to resolve", async () => {
		const {calls} = await run(
			[
				[ONE(9), one({number: 9})],
				[COMMENTS(9), comments(APPROVED)],
				[PERM("founder"), okOut("maintain\n")],
			],
			{issue: 9},
		);
		expect(calls.some((call) => call.includes("/labels"))).toBe(false);
	});

	it("refuses a pull request — a pitch binds at intake and never at merge (#3909)", async () => {
		const {outcome} = await run([[ONE(9), one({number: 9, pull: true})]], {issue: 9});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("pull request");
	});

	it("refuses an issue that does not exist rather than passing over an empty scan", async () => {
		const {outcome} = await run([[ONE(9), errOut("gh: Not Found (HTTP 404)")]], {issue: 9});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("does not exist");
	});

	it("refuses a non-issue-number argument before it reads anything", async () => {
		const {outcome, calls} = await run([], {issue: 0});
		expect(outcome.code).toBe(FAILED);
		expect(calls).toEqual([]);
	});
});

describe("runPitchGuard — repo resolution", () => {
	it("reds 11 when no target repo resolves — nothing was scanned", async () => {
		const {outcome} = await run([[/^git config --get remote.origin.url/, errOut("no remote")]], {
			env: {},
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("cannot resolve a target repo");
	});
});
