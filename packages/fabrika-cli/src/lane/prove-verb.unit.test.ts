import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import {readGoldenFixture} from "../golden-fixture.ts";
import type {ExecResult} from "../io/exec.ts";
import {contentDigest, parseRaw} from "../review/content-binding.ts";
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

	it("writes nothing on any path — the ledger append stays lane transition's (single-issue)", async () => {
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

/**
 * The epic-lane arms (ADR 0285): a child opens no PR, so its `DONE` stands on the commits its branch
 * adds over the epic branch and its `PASS` on a range-bound verdict on the child issue. The tail is
 * the one PR, and reaches the same arms a single-issue lane always has.
 */
const EPIC_ROOT = `${ROOT}/4300`;
const EPIC_WORKFLOW = `${EPIC_ROOT}/workflow.json`;
const EPIC_LOG = `${EPIC_ROOT}/events.jsonl`;
const EPIC_BASE = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const CHILD_TIP = "9f2c1abf0e1d2c3b4a5968778695a4b3c2d1e0f9";
const CHILD_BRANCH = "build/4301-range-arms-154c981b";
const CHILD_MESSAGE = "feat(lane): prove a child range (#4301)";

const epicWorkflowText = (): string =>
	readGoldenFixture(import.meta.url, "./__fixtures__/epic-4300.workflow.golden.txt");

const epicLine = (task: string, event: string, at: string): string =>
	`${JSON.stringify({task, event: `${task.toUpperCase()}.${event}`, at})}\n`;

/** One child's whole local loop: build, review, then the integrate that lands its range. */
const landed = (child: number, hour: number): string =>
	["WIP", "DONE", "PASS", "DONE"]
		.map((event, index) =>
			epicLine(
				`issue_${child}`,
				event,
				`2026-08-16T${String(hour + index).padStart(2, "0")}:00:00Z`,
			),
		)
		.join("");

/** The epic lane with `issue_4301` in `build`, in `review`, or every child landed and the tail up. */
const epicLaneAt = (state: "build" | "review" | "tail") =>
	fakeFs({
		files: {
			[EPIC_WORKFLOW]: epicWorkflowText(),
			[EPIC_LOG]:
				state === "tail"
					? landed(4301, 1) + landed(4302, 1) + landed(4303, 1)
					: state === "build"
						? epicLine("issue_4301", "WIP", "2026-08-16T01:00:00Z")
						: epicLine("issue_4301", "WIP", "2026-08-16T01:00:00Z") +
							epicLine("issue_4301", "DONE", "2026-08-16T02:00:00Z"),
		},
	});

const runEpic = (
	fs: ReturnType<typeof fakeFs>,
	shell: ReturnType<typeof fakeShell>,
	event: string,
	task: string,
) =>
	Effect.runPromise(
		Effect.provide(
			runProve({
				root: ROOT,
				lane: "4300",
				event,
				task,
				repo: null,
				env: {CLAUDE_PIPELINE_REPO: "o/r"},
			}),
			Layer.mergeAll(fs.layer, shell.layer),
		),
	);

const REV = (rev: string) => new RegExp(`^git rev-parse --verify --quiet ${rev}\\^\\{commit\\}$`);
const BRANCHES = /^git for-each-ref --format=%\(refname:short\) refs\/heads$/;
const LOG_RANGE = /^git log --format=/;
const RAW = /^git diff .* --raw --abbrev=40 -z /;
const CHILD_COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4301\/comments/;

/** `git log`'s framing for one commit: `<sha>\x1f<message>\x1e`. */
const logOf = (...rows: ReadonlyArray<readonly [string, string]>): ExecResult =>
	okOut(rows.map(([sha, message]) => `${sha}\x1f${message}\n\x1e`).join(""));

const rawRecord = (path: string): string => `:100644 100644 ${EPIC_BASE} ${CHILD_TIP} M\0${path}\0`;

const CHILD_RAW = rawRecord("packages/fabrika-cli/src/lane/prove.ts");
const digestOf = (raw: string): string => {
	const parsed = parseRaw(raw);
	if (typeof parsed === "string") throw new Error(parsed);
	return contentDigest(parsed);
};
const CHILD_DIGEST = digestOf(CHILD_RAW);
const OTHER_DIGEST = digestOf(rawRecord("packages/fabrika-cli/src/lane/emit.ts"));

/** The git reads that locate the one child branch and the range it adds. */
const locating = (
	branches: ReadonlyArray<string> = [CHILD_BRANCH, "main", "epic/4300"],
	commits: ReadonlyArray<readonly [string, string]> = [[CHILD_TIP, CHILD_MESSAGE]],
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[REV("epic/4300"), okOut(`${EPIC_BASE}\n`)],
	[BRANCHES, okOut(`${branches.join("\n")}\n`)],
	[REV(CHILD_BRANCH.replace(/\//g, "\\/")), okOut(`${CHILD_TIP}\n`)],
	[/^git rev-parse --verify --quiet build\//, okOut(`${CHILD_TIP}\n`)],
	[LOG_RANGE, logOf(...commits)],
];

const rangeMarker = (
	polarity: "PASS" | "FAIL",
	content: string,
	base = EPIC_BASE.slice(0, 7),
	tip = CHILD_TIP.slice(0, 7),
): string =>
	`review-code: ${polarity} range:${base}..${tip} content:${content} — every criterion met`;

describe("lane prove — an epic child's DONE stands on commits, never on a PR", () => {
	it("proves a child DONE from the commits its branch adds over the epic branch", async () => {
		const shell = fakeShell([...locating()]);

		const out = await runEpic(epicLaneAt("build"), shell, "DONE", "issue_4301");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			proof: "proven",
			event: "DONE",
			issue: 4301,
			evidence: {
				kind: "range-commits",
				epic: 4300,
				branch: CHILD_BRANCH,
				range: {base: EPIC_BASE, tip: CHILD_TIP},
				commits: 1,
			},
		});
		expect(shell.calls.filter((line) => line.startsWith("gh "))).toEqual([]);
	});

	it("refuses a child DONE whose branch was cut and never built on", async () => {
		const shell = fakeShell([...locating([CHILD_BRANCH], [])]);

		const out = await runEpic(epicLaneAt("build"), shell, "DONE", "issue_4301");

		expect(out.code).toBe(PROOF_ABSENT);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("cut and not built on");
	});

	it("refuses a child DONE when the branch carries only another child's commits", async () => {
		const shell = fakeShell([
			...locating([CHILD_BRANCH], [[CHILD_TIP, "feat(lane): another child (#4302)"]]),
		]);

		const out = await runEpic(epicLaneAt("build"), shell, "DONE", "issue_4301");

		expect(out.code).toBe(PROOF_ABSENT);
		expect(out.stderr.join("\n")).toContain("names #4301");
	});

	it("refuses a child DONE when two lane branches both carry its commits", async () => {
		const shell = fakeShell([
			[REV("epic/4300"), okOut(`${EPIC_BASE}\n`)],
			[BRANCHES, okOut(`${CHILD_BRANCH}\nbuild/4301-second-try-deadbeef\n`)],
			[/^git rev-parse --verify --quiet build\//, okOut(`${CHILD_TIP}\n`)],
			[LOG_RANGE, logOf([CHILD_TIP, CHILD_MESSAGE])],
		]);

		const out = await runEpic(epicLaneAt("build"), shell, "DONE", "issue_4301");

		expect(out.code).toBe(PROOF_AMBIGUOUS);
		expect(out.stderr.join("\n")).toContain("build/4301-second-try-deadbeef");
	});

	it("leaves a child DONE UNKNOWN when the epic branch is not in this tree", async () => {
		const shell = fakeShell([[REV("epic/4300"), errOut("unknown revision")]]);

		const out = await runEpic(epicLaneAt("build"), shell, "DONE", "issue_4301");

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stderr.join("\n")).toContain("UNKNOWN");
		expect(shell.calls.some((line) => BRANCHES.test(line))).toBe(false);
	});

	it("answers not-required for the DONE that lands a reviewed range, reading nothing", async () => {
		const shell = fakeShell([]);
		const fs = fakeFs({
			files: {
				[EPIC_WORKFLOW]: epicWorkflowText(),
				[EPIC_LOG]:
					epicLine("issue_4301", "WIP", "2026-08-16T01:00:00Z") +
					epicLine("issue_4301", "DONE", "2026-08-16T02:00:00Z") +
					epicLine("issue_4301", "PASS", "2026-08-16T03:00:00Z"),
			},
		});

		const out = await runEpic(fs, shell, "DONE", "issue_4301");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({proof: "not-required", state: "integrate"});
		expect(shell.calls).toEqual([]);
	});
});

describe("lane prove — an epic child's PASS stands on a range verdict that still binds", () => {
	const proving = (...comments: ReadonlyArray<{id: number; body: string}>) =>
		fakeShell([...locating(), [RAW, okOut(CHILD_RAW)], [CHILD_COMMENTS, comments_(comments)]]);

	const comments_ = (rows: ReadonlyArray<{id: number; body: string}>): ExecResult =>
		okOut(
			JSON.stringify(
				rows.map((row) => ({
					id: row.id,
					body: row.body,
					user: {login: "agent"},
					created_at: "2026-08-16T03:00:00Z",
					updated_at: "2026-08-16T03:00:00Z",
				})),
			),
		);

	it("proves a child PASS whose verdict binds the content this range carries now", async () => {
		const shell = proving({id: 1, body: rangeMarker("PASS", CHILD_DIGEST)});

		const out = await runEpic(epicLaneAt("review"), shell, "PASS", "issue_4301");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			proof: "proven",
			event: "PASS",
			issue: 4301,
			evidence: {kind: "range-verdicts", epic: 4300, content: CHILD_DIGEST},
		});
	});

	it("refuses a child PASS with no verdict at all on the child issue", async () => {
		const shell = proving({id: 1, body: "looks good to me"});

		const out = await runEpic(epicLaneAt("review"), shell, "PASS", "issue_4301");

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(out.stderr.join("\n")).toContain("review-code (absent)");
	});

	it("refuses a child PASS whose verdict binds a digest the range has moved past", async () => {
		const shell = proving({id: 1, body: rangeMarker("PASS", "2f1a9c4e0b7d")});

		const out = await runEpic(epicLaneAt("review"), shell, "PASS", "issue_4301");

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(out.stderr.join("\n")).toContain("review-code (stale)");
	});

	it("refuses a child PASS whose verdict was written over another range's content", async () => {
		const shell = proving({
			id: 1,
			body: rangeMarker("PASS", OTHER_DIGEST, "aaaaaaa", "bbbbbbb"),
		});

		const out = await runEpic(epicLaneAt("review"), shell, "PASS", "issue_4301");

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(out.stderr.join("\n")).toContain("review-code (stale)");
		expect(out.stderr.join("\n")).toContain("over range aaaaaaa..bbbbbbb");
	});

	it("refuses a child PASS the child issue contradicts with a range FAIL", async () => {
		const shell = proving({id: 1, body: rangeMarker("FAIL", CHILD_DIGEST)});

		const out = await runEpic(epicLaneAt("review"), shell, "PASS", "issue_4301");

		expect(out.code).toBe(PROOF_CONTRADICTED);
		expect(out.stderr.join("\n")).toContain("FAIL");
	});

	it("names a PR-scoped marker posted on the child issue instead of reading it as no verdict", async () => {
		const shell = proving({id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`});

		const out = await runEpic(epicLaneAt("review"), shell, "PASS", "issue_4301");

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(out.stderr.join("\n")).toContain("is not a range one");
	});

	it("leaves a child PASS UNKNOWN when the range's own content cannot be read", async () => {
		const shell = fakeShell([...locating(), [RAW, errOut("fatal: bad object")]]);

		const out = await runEpic(epicLaneAt("review"), shell, "PASS", "issue_4301");

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stderr.join("\n")).toContain("UNKNOWN");
	});
});

describe("lane prove — the epic tail keeps the PR arms", () => {
	it("proves the tail PASS off the one PR's current-head verdicts, reading no range", async () => {
		const shell = fakeShell([
			[/^gh api graphql -f query=query\(/, closingPulls()],
			[/^gh api --paginate search\/issues/, okOut("4318\n")],
			[
				/^gh api repos\/o\/r\/pulls\/4318$/,
				okOut(
					JSON.stringify({
						number: 4318,
						state: "open",
						head: {sha: HEAD},
						base: {ref: "main"},
						body: "Fixes #4300\n\n## Deviations\nNone.\n",
						changed_files: 1,
						comments: 1,
						merged: false,
					}),
				),
			],
			[
				/^gh api --paginate repos\/o\/r\/pulls\/4318\/files/,
				okOut(JSON.stringify([{filename: "packages/fabrika-cli/src/lane/prove.ts"}])),
			],
			[
				/^gh api --paginate repos\/o\/r\/issues\/4318\/comments/,
				comments({id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`}),
			],
		]);

		const out = await runEpic(epicLaneAt("tail"), shell, "PASS", "epic_4300");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			proof: "proven",
			issue: 4300,
			evidence: {kind: "head-verdicts", pr: 4318, head: HEAD},
		});
		expect(shell.calls.some((line) => BRANCHES.test(line))).toBe(false);
	});
});
