/**
 * `guard pitch-guard check` over a scripted GitHub — the two scopes, the three-read hydration, and
 * every read failure that has to land as UNKNOWN rather than as a clean or a red.
 *
 * The read ORDER is asserted by the requests the verb issues: the sweep narrows at the endpoint,
 * each shortlisted issue is re-read singly for the parent link the list omits, and the ACL is
 * resolved per comment author, fail-closed.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import {FAILED} from "../verb.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {type BetRowsReader, runPitchGuard} from "./pitch-verb.ts";

const SWEEP = /^GET .*\/repos\/o\/r\/issues\?state=open&labels=status%3Atriaged/;
const ONE = (n: number) => new RegExp(`^GET .*/repos/o/r/issues/${n}$`);
const COMMENTS = (n: number) => new RegExp(`^GET .*/repos/o/r/issues/${n}/comments`);
const PERM = (login: string) => new RegExp(`^GET .*/repos/o/r/collaborators/${login}/permission`);
const LABELS = /^GET .*\/repos\/o\/r\/labels/;

/** One collaborator's repository permission, in the record the ACL read parses. */
const permission = (level: string): HttpReply => ({
	status: 200,
	body: JSON.stringify({permission: level}),
});

/** The repository's defined labels, as the bare JSON array the universe read walks. */
const labelSet = (...names: ReadonlyArray<string>): HttpReply => ({
	status: 200,
	body: JSON.stringify(names.map((name) => ({name}))),
});

const EMPTY: HttpReply = {status: 200, body: "[]"};
const BAD_GATEWAY: HttpReply = {status: 502, body: "{}"};

const ENV = {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>;

const PITCH = [
	"## Pitch",
	"",
	"**Problem:** yazars cannot find last week's definition.",
	"**Arc:** product search discovery",
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

const sweep = (...shapes: ReadonlyArray<IssueShape>): HttpReply => ({
	status: 200,
	body: JSON.stringify(shapes.map(payload)),
});

const one = (shape: IssueShape): HttpReply => ({
	status: 200,
	body: JSON.stringify(payload(shape)),
});

const comments = (...bodies: ReadonlyArray<{author: string; body: string}>): HttpReply => ({
	status: 200,
	body: JSON.stringify(
		bodies.map((entry, index) => ({
			id: index + 1,
			user: {login: entry.author},
			created_at: "2026-08-18T00:00:00Z",
			updated_at: "2026-08-18T00:00:00Z",
			body: entry.body,
		})),
	),
});

const APPROVED = {
	author: "founder",
	body: "pitch-approved: appetite 2 cycles · 2026-08-18T00:00:00Z",
};

const ROOT = "/repo";

const run = (
	script: ReadonlyArray<Scripted>,
	options: {
		issue?: number;
		repo?: string | null;
		env?: Record<string, string | undefined>;
		config?: string;
		betRows?: BetRowsReader;
	} = {},
) => {
	const seams = fakeSeams(script);
	const fs = fakeFs(
		options.config === undefined ? {} : {files: {[`${ROOT}/.fabrika.jsonc`]: options.config}},
	);
	return Effect.runPromise(
		Effect.provide(
			runPitchGuard({
				issue: options.issue ?? null,
				repo: options.repo ?? null,
				cwd: ROOT,
				env: options.env ?? ENV,
				...(options.betRows === undefined ? {} : {betRows: options.betRows}),
			}),
			Layer.merge(fs.layer, seams.layer),
		),
	).then((outcome) => ({outcome, requests: seams.requests}));
};

describe("runPitchGuard — the backlog sweep", () => {
	it("passes and reports what it scanned when every bet carries an approved pitch", async () => {
		const {outcome} = await run([
			[SWEEP, sweep({number: 11})],
			[ONE(11), one({number: 11})],
			[COMMENTS(11), comments(APPROVED)],
			[PERM("founder"), permission("admin")],
		]);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("scanned 1 lane-entering issue(s)");
	});

	it("narrows at the endpoint, then re-reads each shortlisted issue for its parent link", async () => {
		const {requests} = await run([
			[SWEEP, sweep({number: 11}, {number: 12, labels: ["status:triaged", "type:chore"]})],
			[ONE(11), one({number: 11})],
			[COMMENTS(11), comments(APPROVED)],
			[PERM("founder"), permission("write")],
		]);
		expect(requests[0]).toContain("labels=status%3Atriaged");
		// The chore is filtered before the single read — a non-bet costs no extra call.
		expect(requests).not.toContain("GET https://api.github.com/repos/o/r/issues/12");
		expect(requests).toContain("GET https://api.github.com/repos/o/r/issues/11");
	});

	it("holds a sub-issue out of scope — it inherits its epic's pitch", async () => {
		const {outcome} = await run([
			[SWEEP, sweep({number: 11})],
			[ONE(11), one({number: 11, parent: true, body: "no pitch here"})],
			[COMMENTS(11), EMPTY],
		]);
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("reds 12 on a pickable bet with no pitch, naming it and the draft/approve remedy", async () => {
		const {outcome} = await run([
			[SWEEP, sweep({number: 11})],
			[ONE(11), one({number: 11, body: "no pitch here"})],
			[COMMENTS(11), EMPTY],
		]);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		const report = outcome.stderr.join("\n");
		expect(report).toContain("#11 issue 11");
		expect(report).toContain("has no `## Pitch` section");
		expect(report).toContain("the FOUNDER approves it");
		expect(report).toContain(".glossary/TERMS.md");
	});

	it("refuses an approval from below write+ — an unverifiable one never counts", async () => {
		const {outcome} = await run([
			[SWEEP, sweep({number: 11})],
			[ONE(11), one({number: 11})],
			[COMMENTS(11), comments({author: "drive-by", body: "pitch-approved: appetite 2 cycles"})],
			[PERM("drive-by"), permission("read")],
		]);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("not from a write+ collaborator");
	});

	it("resolves an UNREADABLE permission as not authorized rather than erroring the run", async () => {
		const {outcome} = await run([
			[SWEEP, sweep({number: 11})],
			[ONE(11), one({number: 11})],
			[COMMENTS(11), comments(APPROVED)],
			[PERM("founder"), BAD_GATEWAY],
		]);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("not from a write+ collaborator");
	});

	it("reds 7 on an empty sweep — a vacuous pass would hide every unpitched bet", async () => {
		const {outcome} = await run([[SWEEP, EMPTY]]);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("ZERO lane-entering issues");
		expect(outcome.stderr.join("\n")).toContain("fail-closed");
	});

	it("reds 11 when the board cannot be read — never clean, never a violation", async () => {
		const {outcome} = await run([[SWEEP, BAD_GATEWAY]]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("reds 11 when a shortlisted issue's comments cannot be read — part of the set went unread", async () => {
		const {outcome} = await run([
			[SWEEP, sweep({number: 11})],
			[ONE(11), one({number: 11})],
			[COMMENTS(11), BAD_GATEWAY],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("went unread");
	});

	it("emits a ::error annotation for every refusal under Actions", async () => {
		const {outcome} = await run([[SWEEP, EMPTY]], {
			env: {...ENV, GITHUB_ACTIONS: "true"},
		});
		expect(outcome.stderr.some((line) => line.startsWith("::error"))).toBe(true);
	});
});

describe("runPitchGuard — the --issue seam", () => {
	it("scans just that issue and reds it when it became pickable unpitched", async () => {
		const {outcome, requests} = await run(
			[
				[ONE(9), one({number: 9, body: "no pitch"})],
				[COMMENTS(9), EMPTY],
			],
			{issue: 9},
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("#9 issue 9");
		expect(requests.some((request) => SWEEP.test(request))).toBe(false);
	});

	it("passes an out-of-scope issue where the scoping labels exist, reading the label set once", async () => {
		const {outcome, requests} = await run(
			[
				[ONE(9), one({number: 9, labels: ["status:triaged", "type:chore"]})],
				[LABELS, labelSet("status:triaged", "type:epic", "type:feature")],
			],
			{issue: 9},
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("not lane-entering work");
		expect(requests.some((request) => request.includes("/labels"))).toBe(true);
	});

	it("reds 11 on an out-of-scope issue in a repo missing the scoping labels (#4272)", async () => {
		const {outcome} = await run(
			[
				[ONE(9), one({number: 9, labels: ["status:triaged", "type:chore"]})],
				[LABELS, labelSet("bug")],
			],
			{issue: 9},
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("do not exist in this repo");
	});

	it("does not read the label set when the issue IS lane-entering — no ambiguity to resolve", async () => {
		const {requests} = await run(
			[
				[ONE(9), one({number: 9})],
				[COMMENTS(9), comments(APPROVED)],
				[PERM("founder"), permission("maintain")],
			],
			{issue: 9},
		);
		expect(requests.some((request) => request.includes("/labels"))).toBe(false);
	});

	it("refuses a pull request — a pitch binds at intake and never at merge (#3909)", async () => {
		const {outcome} = await run([[ONE(9), one({number: 9, pull: true})]], {issue: 9});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("pull request");
	});

	it("refuses an issue that does not exist rather than passing over an empty scan", async () => {
		const {outcome} = await run([[ONE(9), {status: 404, body: '{"message":"Not Found"}'}]], {
			issue: 9,
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("does not exist");
	});

	it("refuses a non-issue-number argument before it reads anything", async () => {
		const {outcome, requests} = await run([], {issue: 0});
		expect(outcome.code).toBe(FAILED);
		expect(requests).toEqual([]);
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

describe("runPitchGuard — pitch sizes and the config they are priced in", () => {
	const SIZED = PITCH.replace("2 cycles", "M");

	it("passes a size pitch approved as `appetite M`", async () => {
		const {outcome} = await run(
			[
				[ONE(9), one({number: 9, body: SIZED})],
				[COMMENTS(9), comments({author: "founder", body: "pitch-approved: appetite M"})],
				[PERM("founder"), permission("admin")],
			],
			{issue: 9},
		);
		expect(outcome.code).toBe(0);
	});

	it("prices the sizes in its remedy from the repo's declared appetiteSizes", async () => {
		const {outcome} = await run(
			[
				[ONE(9), one({number: 9, body: SIZED})],
				[COMMENTS(9), EMPTY],
			],
			{issue: 9, config: JSON.stringify({appetiteSizes: {S: 5, M: 9, L: 12}})},
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("S = $5, M = $9, L = $12 per epic child");
		expect(outcome.stderr.join("\n")).toContain("pitch-approved: appetite <S|M|L>");
	});

	it("prices them at the shipped 15 / 35 / 40 when the repo declares nothing", async () => {
		const {outcome} = await run(
			[
				[ONE(9), one({number: 9, body: SIZED})],
				[COMMENTS(9), EMPTY],
			],
			{issue: 9},
		);
		expect(outcome.stderr.join("\n")).toContain("S = $15, M = $35, L = $40 per epic child");
	});

	it("reds 11 over a malformed appetiteSizes before it reads the board", async () => {
		const {outcome, requests} = await run([], {
			issue: 9,
			config: JSON.stringify({appetiteSizes: {S: 40, M: 35, L: 15}}),
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("appetiteSizes");
		expect(requests).toEqual([]);
	});
});

describe("runPitchGuard — a `bet` on the table is the approval", () => {
	const SIZED = PITCH.replace("2 cycles", "M");
	/** A table whose only `bet` rows are these, each defaulting to Size M set by `founder`. */
	const betsOn =
		(
			...rows: ReadonlyArray<{head: number; covers?: number[]; size?: string; setter?: string}>
		): BetRowsReader =>
		() =>
			Effect.succeed({
				_tag: "Read",
				source: {owner: "o", number: 7},
				value: rows.map((row) => ({
					head: row.head,
					covers: row.covers ?? [row.head],
					kind: row.covers === undefined ? null : ("chain" as const),
					size: row.size ?? "M",
					setter: row.setter ?? "founder",
				})),
			});

	it("passes a size pitch with no `pitch-approved:` comment once a write+ collaborator bet on it", async () => {
		const {outcome, requests} = await run(
			[
				[ONE(9), one({number: 9, body: SIZED})],
				[COMMENTS(9), EMPTY],
				[PERM("founder"), permission("admin")],
			],
			{issue: 9, betRows: betsOn({head: 9})},
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stderr[0]).toContain("bet arm read the table o#7 — 1 `bet` row(s)");
		expect(requests.some((request) => PERM("founder").test(request))).toBe(true);
	});

	it("refuses a `bet` whose Stage setter lacks write access, naming why", async () => {
		const {outcome} = await run(
			[
				[ONE(9), one({number: 9, body: SIZED})],
				[COMMENTS(9), EMPTY],
				[PERM("drive-by"), permission("triage")],
			],
			{issue: 9, betRows: betsOn({head: 9, setter: "drive-by"})},
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("set by drive-by, not a write+ collaborator");
	});

	it("approves the head and every member of a chain row with no comment on any of them", async () => {
		const {outcome} = await run(
			[
				[SWEEP, sweep({number: 20}, {number: 21})],
				[ONE(20), one({number: 20, body: SIZED})],
				[ONE(21), one({number: 21, body: SIZED.replace("**Appetite:** M", "**Appetite:** S")})],
				[COMMENTS(20), EMPTY],
				[COMMENTS(21), EMPTY],
				[PERM("founder"), permission("write")],
			],
			{betRows: betsOn({head: 20, covers: [20, 21]})},
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("2 carrying a founder-approved pitch");
	});

	it("approves no chain member while the row's Size is not the size its head's pitch declares", async () => {
		const {outcome, requests} = await run(
			[
				[ONE(21), one({number: 21, body: SIZED})],
				[COMMENTS(21), EMPTY],
				[PERM("founder"), permission("admin")],
				[ONE(20), one({number: 20, body: SIZED.replace("**Appetite:** M", "**Appetite:** L")})],
			],
			{issue: 21, betRows: betsOn({head: 20, covers: [20, 21]})},
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain(
			"its group `bet` row #20 approves no member: it is sized M but its head #20 declares L",
		);
		expect(requests.some((request) => ONE(20).test(request))).toBe(true);
	});

	it("refuses a `bet` whose Size disagrees with the pitch's appetite, asking for re-approval", async () => {
		const {outcome} = await run(
			[
				[ONE(9), one({number: 9, body: SIZED})],
				[COMMENTS(9), EMPTY],
				[PERM("founder"), permission("admin")],
			],
			{issue: 9, betRows: betsOn({head: 9, size: "L"})},
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain(
			"sized L but the body declares M — re-approval needed",
		);
	});

	it("decides from comments exactly as before when no table is configured, naming the unread arm", async () => {
		const noTable: BetRowsReader = () =>
			Effect.succeed({_tag: "NoTable", note: "no table project — none is configured"});
		const approved = await run(
			[
				[ONE(9), one({number: 9, body: SIZED})],
				[COMMENTS(9), comments({author: "founder", body: "pitch-approved: appetite M"})],
				[PERM("founder"), permission("admin")],
			],
			{issue: 9, betRows: noTable},
		);
		expect(approved.outcome.code).toBe(0);
		expect(approved.outcome.stderr[0]).toContain(
			"bet arm unread — no table project — none is configured",
		);
		const bare = await run(
			[
				[ONE(9), one({number: 9, body: SIZED})],
				[COMMENTS(9), EMPTY],
			],
			{issue: 9, betRows: noTable},
		);
		expect(bare.outcome.code).toBe(VIOLATION);
		expect(bare.outcome.stderr.join("\n")).not.toContain("`bet` row");
	});

	it("reads a token without the `project` scope as an unread arm, never as approved", async () => {
		const noScope: BetRowsReader = () =>
			Effect.succeed({_tag: "Unknown", reason: "the GitHub token lacks the `project` scope"});
		const {outcome} = await run(
			[
				[ONE(9), one({number: 9, body: SIZED})],
				[COMMENTS(9), EMPTY],
			],
			{issue: 9, betRows: noScope},
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr[0]).toContain(
			"bet arm unread — the GitHub token lacks the `project` scope",
		);
	});

	it("does not read the table for an issue that is not lane-entering work", async () => {
		let read = false;
		const watched: BetRowsReader = () =>
			Effect.sync(() => {
				read = true;
				return {_tag: "NoTable", note: "unused"} as const;
			});
		await run(
			[
				[ONE(9), one({number: 9, labels: ["status:triaged", "type:chore"]})],
				[LABELS, labelSet("status:triaged", "type:epic", "type:feature")],
			],
			{issue: 9, betRows: watched},
		);
		expect(read).toBe(false);
	});
});
