import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	LANE_UNREADABLE,
	PROOF_ABSENT,
	PROOF_AMBIGUOUS,
	PROOF_CONTRADICTED,
	PROOF_IN_FLIGHT,
} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {runProve} from "./prove-verb.ts";

const ROOT = ".fabrika/lanes";
const WORKFLOW = `${ROOT}/5747/workflow.json`;
const LOG = `${ROOT}/5747/events.jsonl`;
const HEAD = "03135b9188d2be6c0a4b7bd0b7a3ff9c53f0f2b1";
const OLD = "8f1c2ad4e5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0";

const CLOSERS = /^gh api graphql -f query=query\(/;
const SEARCH = /^gh api --paginate search\/issues/;
const PULL = /^gh api repos\/o\/r\/pulls\/4318$/;
const FILES = /^gh api --paginate repos\/o\/r\/pulls\/4318\/files/;
const PR_COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4318\/comments/;
const ISSUE = /^gh api repos\/o\/r\/issues\/5747$/;
const ISSUE_COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/5747\/comments/;

/** One page of the closing-issue link edge, every node OPEN — the verb filters on that itself. */
const closingPulls = (...numbers: ReadonlyArray<number>): ExecResult =>
	okOut(
		JSON.stringify({
			data: {
				repository: {
					issue: {
						closedByPullRequestsReferences: {
							pageInfo: {hasNextPage: false, endCursor: null},
							nodes: numbers.map((number) => ({
								number,
								url: `https://github.com/o/r/pull/${number}`,
								state: "OPEN",
							})),
						},
					},
				},
			},
		}),
	);

const logLine = (event: string, at: string): string =>
	`${JSON.stringify({task: "issue", event: `ISSUE.${event}`, at})}\n`;

/** The lane in `build` (one WIP), or in `review` (WIP then DONE). */
const laneAt = (state: "build" | "review") =>
	fakeFs({
		files: {
			[WORKFLOW]: coderTemplateText(),
			[LOG]:
				state === "build"
					? logLine("WIP", "2026-08-16T01:00:00Z")
					: logLine("WIP", "2026-08-16T01:00:00Z") + logLine("DONE", "2026-08-16T02:00:00Z"),
		},
	});

const pull = (overrides: Record<string, unknown> = {}): ExecResult =>
	okOut(
		JSON.stringify({
			number: 4318,
			state: "open",
			head: {sha: HEAD},
			base: {ref: "main"},
			body: "Fixes #5747\n\n## Deviations\nNone.\n",
			changed_files: 1,
			comments: 1,
			merged: false,
			...overrides,
		}),
	);

const comments = (
	...rows: ReadonlyArray<{id: number; body: string; createdAt?: string}>
): ExecResult =>
	okOut(
		JSON.stringify(
			rows.map((row) => ({
				id: row.id,
				body: row.body,
				user: {login: "agent"},
				created_at: row.createdAt ?? "2026-08-16T03:00:00Z",
				updated_at: row.createdAt ?? "2026-08-16T03:00:00Z",
			})),
		),
	);

const issue = (labels: ReadonlyArray<string>): ExecResult =>
	okOut(
		JSON.stringify({
			number: 5747,
			title: "a lane task",
			body: "",
			state: "open",
			labels: labels.map((name) => ({name})),
			html_url: "https://github.com/o/r/issues/5747",
		}),
	);

const run = (fs: ReturnType<typeof fakeFs>, shell: ReturnType<typeof fakeShell>, event: string) =>
	Effect.runPromise(
		Effect.provide(
			runProve({
				root: ROOT,
				lane: "5747",
				event,
				task: null,
				repo: null,
				env: {CLAUDE_PIPELINE_REPO: "o/r"},
			}),
			Layer.mergeAll(fs.layer, shell.layer),
		),
	);

describe("lane prove — the two events that carry a claim", () => {
	it("proves a build DONE against the one open PR whose body links the issue", async () => {
		const shell = fakeShell([
			[CLOSERS, closingPulls()],
			[SEARCH, okOut("4318\n")],
			[PULL, pull()],
		]);

		const out = await run(laneAt("build"), shell, "DONE");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			proof: "proven",
			event: "DONE",
			issue: 5747,
			evidence: {kind: "open-pull", pr: 4318},
		});
	});

	it("proves a review PASS when every derived namespace passes at the live head", async () => {
		const shell = fakeShell([
			[CLOSERS, closingPulls()],
			[SEARCH, okOut("4318\n")],
			[PULL, pull()],
			[FILES, okOut(JSON.stringify([{filename: "packages/fabrika-cli/src/lane/prove.ts"}]))],
			[PR_COMMENTS, comments({id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`})],
		]);

		const out = await run(laneAt("review"), shell, "PASS");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			proof: "proven",
			evidence: {kind: "head-verdicts", pr: 4318, head: HEAD},
		});
	});
});

describe("lane prove — the refusals, each on its own remedy", () => {
	it("refuses a build DONE with no open PR and no no-PR outcome, naming what it looked for", async () => {
		const shell = fakeShell([
			[CLOSERS, closingPulls()],
			[SEARCH, okOut("")],
			[ISSUE, issue(["type:feature"])],
			[ISSUE_COMMENTS, comments()],
		]);

		const out = await run(laneAt("build"), shell, "DONE");

		expect(out.code).toBe(PROOF_ABSENT);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("whose body links #5747");
		expect(out.stderr.join("\n")).toContain("type:investigation");
	});

	it("refuses a build DONE when several open PRs link the issue", async () => {
		const shell = fakeShell([
			[CLOSERS, closingPulls()],
			[SEARCH, okOut("4318\n4319\n")],
			[PULL, pull()],
			[/^gh api repos\/o\/r\/pulls\/4319$/, pull({number: 4319})],
		]);

		const out = await run(laneAt("build"), shell, "DONE");

		expect(out.code).toBe(PROOF_AMBIGUOUS);
		expect(out.stderr.join("\n")).toContain("#4318, #4319");
	});

	it("refuses a PASS while a derived namespace has no current-head verdict", async () => {
		const shell = fakeShell([
			[CLOSERS, closingPulls()],
			[SEARCH, okOut("4318\n")],
			[PULL, pull()],
			[
				FILES,
				okOut(JSON.stringify([{filename: "claude-plugins/fabrika/skills/operate/SKILL.md"}])),
			],
			[PR_COMMENTS, comments({id: 1, body: `review-skill: PASS @ ${HEAD} — reads clean`})],
		]);

		const out = await run(laneAt("review"), shell, "PASS");

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(out.stderr.join("\n")).toContain("governance (absent)");
	});

	it("refuses a PASS whose namespace verdict is at a head the PR has moved past", async () => {
		const shell = fakeShell([
			[CLOSERS, closingPulls()],
			[SEARCH, okOut("4318\n")],
			[PULL, pull()],
			[FILES, okOut(JSON.stringify([{filename: "packages/fabrika-cli/src/lane/prove.ts"}]))],
			[PR_COMMENTS, comments({id: 1, body: `review-code: PASS @ ${OLD} — merge-ready`})],
		]);

		const out = await run(laneAt("review"), shell, "PASS");

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(out.stderr.join("\n")).toContain("review-code (stale)");
	});

	it("refuses a PASS the board contradicts with a current-head FAIL", async () => {
		const shell = fakeShell([
			[CLOSERS, closingPulls()],
			[SEARCH, okOut("4318\n")],
			[PULL, pull()],
			[FILES, okOut(JSON.stringify([{filename: "packages/fabrika-cli/src/lane/prove.ts"}]))],
			[PR_COMMENTS, comments({id: 1, body: `review-code: FAIL @ ${HEAD} — the fold drops a row`})],
		]);

		const out = await run(laneAt("review"), shell, "PASS");

		expect(out.code).toBe(PROOF_CONTRADICTED);
		expect(out.stderr.join("\n")).toContain("FAIL");
	});

	it("leaves the proof UNKNOWN when a board read fails — never proven, never absent", async () => {
		const shell = fakeShell([
			[CLOSERS, closingPulls()],
			[SEARCH, errOut("HTTP 502")],
		]);

		const out = await run(laneAt("build"), shell, "DONE");

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("leaves the proof UNKNOWN when the closing-issue edge fails, before any search", async () => {
		const shell = fakeShell([[CLOSERS, errOut("HTTP 502")]]);

		const out = await run(laneAt("build"), shell, "DONE");

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stderr.join("\n")).toContain("closing #5747");
		expect(shell.calls.some((line) => SEARCH.test(line))).toBe(false);
	});
});

describe("lane prove — the union of the two nomination reads", () => {
	it("proves a DONE off the closing edge while the search index still lags the fresh PR", async () => {
		const shell = fakeShell([
			[CLOSERS, closingPulls(4318)],
			[SEARCH, okOut("")],
			[PULL, pull()],
		]);

		const out = await run(laneAt("build"), shell, "DONE");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({evidence: {kind: "open-pull", pr: 4318}});
	});

	it("proves a DONE off the search nomination for a Part of PR the closing edge cannot see", async () => {
		const shell = fakeShell([
			[CLOSERS, closingPulls()],
			[SEARCH, okOut("4318\n")],
			[PULL, pull({body: "Part of #5747\n\n## Deviations\nNone.\n"})],
		]);

		const out = await run(laneAt("build"), shell, "DONE");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({evidence: {kind: "open-pull", pr: 4318}});
	});

	it("counts a PR both reads nominate once, so agreement is not ambiguity", async () => {
		const shell = fakeShell([
			[CLOSERS, closingPulls(4318)],
			[SEARCH, okOut("4318\n")],
			[PULL, pull()],
		]);

		const out = await run(laneAt("build"), shell, "DONE");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({evidence: {kind: "open-pull", pr: 4318}});
		expect(shell.calls.filter((line) => PULL.test(line))).toHaveLength(1);
	});
});

describe("lane prove — what it does not claim, and what it never writes", () => {
	it("answers not-required for an event no board read can falsify, reading nothing", async () => {
		const shell = fakeShell([]);
		const fs = laneAt("build");

		const out = await run(fs, shell, "BLOCKED");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({proof: "not-required", state: "build"});
		expect(shell.calls).toEqual([]);
	});

	it("proves a no-PR builder outcome from the investigation label and its diagnosis", async () => {
		const shell = fakeShell([
			[CLOSERS, closingPulls()],
			[SEARCH, okOut("")],
			[ISSUE, issue(["type:investigation"])],
			[
				ISSUE_COMMENTS,
				comments({id: 900, body: "the loader races the fold", createdAt: "2026-08-16T04:00:00Z"}),
			],
		]);

		const out = await run(laneAt("build"), shell, "DONE");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			proof: "proven",
			evidence: {kind: "diagnosis", commentId: 900},
		});
	});

	it("refuses a no-PR DONE whose only comment predates the build", async () => {
		const shell = fakeShell([
			[CLOSERS, closingPulls()],
			[SEARCH, okOut("")],
			[ISSUE, issue(["type:investigation"])],
			[ISSUE_COMMENTS, comments({id: 900, body: "triaged", createdAt: "2026-08-16T00:30:00Z"})],
		]);

		const out = await run(laneAt("build"), shell, "DONE");

		expect(out.code).toBe(PROOF_ABSENT);
	});

	it("writes nothing on any path — the ledger append stays lane transition's", async () => {
		const fs = laneAt("build");
		const shell = fakeShell([
			[CLOSERS, closingPulls()],
			[SEARCH, okOut("4318\n")],
			[PULL, pull()],
		]);

		await run(fs, shell, "DONE");

		expect(fs.written.size).toBe(0);
	});
});
