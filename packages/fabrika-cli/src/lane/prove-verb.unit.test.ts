import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {
	errOut,
	fakeFs,
	fakeSeams,
	type HttpReply,
	okOut,
	type Scripted,
} from "../fakes.test-support.ts";
import {readGoldenFixture} from "../golden-fixture.ts";
import type {ExecResult} from "../io/exec.ts";
import {contentDigest, parseRaw} from "../review/content-binding.ts";
import {compose as supersedeWith} from "../review/supersede.ts";
import {
	LANE_UNREADABLE,
	PROOF_ABSENT,
	PROOF_AMBIGUOUS,
	PROOF_CONTRADICTED,
	PROOF_IN_FLIGHT,
} from "./codes.ts";
import {coderTemplateText, coderWorkflow} from "./fixtures.test-support.ts";
import {runProve} from "./prove-verb.ts";

const ROOT = ".fabrika/lanes";
const WORKFLOW = `${ROOT}/5747/workflow.json`;
const LOG = `${ROOT}/5747/events.jsonl`;
const HEAD = "03135b9188d2be6c0a4b7bd0b7a3ff9c53f0f2b1";
const OLD = "8f1c2ad4e5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0";

const CLOSERS = /^POST .*\/graphql$/;
const SEARCH = /^GET .*\/search\/issues\?/;
const PULL = /^GET .*\/repos\/o\/r\/pulls\/4318$/;
const FILES = /^GET .*\/repos\/o\/r\/pulls\/4318\/files\?/;
const PR_COMMENTS = /^GET .*\/repos\/o\/r\/issues\/4318\/comments\?/;
const ISSUE = /^GET .*\/repos\/o\/r\/issues\/5747$/;
const ISSUE_COMMENTS = /^GET .*\/repos\/o\/r\/issues\/5747\/comments\?/;

const served = (payload: unknown): HttpReply => ({status: 200, body: JSON.stringify(payload)});
const GATEWAY: HttpReply = {status: 502, body: '{"message":"Bad gateway"}'};

/** The `{total_count, items}` envelope the search index answers with. */
const nominated = (...numbers: ReadonlyArray<number>): HttpReply =>
	served({
		total_count: numbers.length,
		items: numbers.map((number) => ({number, title: `pull ${number}`})),
	});

/** One page of the closing-issue link edge, every node OPEN — the verb filters on that itself. */
const closingPulls = (...numbers: ReadonlyArray<number>): HttpReply =>
	served({
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
	});

const logLine = (event: string, at: string, classes?: ReadonlyArray<string>): string =>
	`${JSON.stringify({task: "issue", event: `ISSUE.${event}`, at, ...(classes === undefined ? {} : {classes})})}\n`;

/**
 * The lane in `build` (one WIP), in `review` (WIP then DONE), or in `review:ui` — which is the same
 * path with `ui` standing from the `WIP`, so the `PASS` out of `review` took the class-guarded arm.
 */
const laneAt = (state: "build" | "review" | "review:ui") =>
	fakeFs({
		files: {
			[WORKFLOW]: coderTemplateText(),
			[LOG]:
				state === "build"
					? logLine("WIP", "2026-08-16T01:00:00Z")
					: state === "review"
						? logLine("WIP", "2026-08-16T01:00:00Z") + logLine("DONE", "2026-08-16T02:00:00Z")
						: logLine("WIP", "2026-08-16T01:00:00Z", ["ui"]) +
							logLine("DONE", "2026-08-16T02:00:00Z") +
							logLine("PASS", "2026-08-16T03:00:00Z"),
		},
	});

/**
 * The same lane in `review`, on a machine whose `review` `PASS` targets `ship` outright — no
 * `class:ui` arm, and no `review:ui` state to reach. Built by collapsing the coder template's
 * guarded array rather than hand-writing a document, so it stays the shipped machine minus exactly
 * the one arm under test.
 */
const laneWithNoUiArm = () => {
	const document = coderWorkflow() as {
		machine: {
			states: Record<
				string,
				{states: Record<string, {states: Record<string, {on: Record<string, unknown>}>}>}
			>;
		};
	};
	const states = document.machine.states.pipeline?.states.issue?.states;
	if (states?.review === undefined) throw new Error("the coder template holds no review state");
	states.review.on["ISSUE.PASS"] = "ship";
	delete states["review:ui"];
	return fakeFs({
		files: {
			[WORKFLOW]: JSON.stringify(document),
			[LOG]: logLine("WIP", "2026-08-16T01:00:00Z") + logLine("DONE", "2026-08-16T02:00:00Z"),
		},
	});
};

const pull = (overrides: Record<string, unknown> = {}): HttpReply =>
	served({
		number: 4318,
		state: "open",
		head: {sha: HEAD},
		base: {ref: "main"},
		body: "Fixes #5747\n\n## Deviations\nNone.\n",
		changed_files: 1,
		comments: 1,
		merged: false,
		...overrides,
	});

const comments = (
	...rows: ReadonlyArray<{id: number; body: string; createdAt?: string}>
): HttpReply =>
	served(
		rows.map((row) => ({
			id: row.id,
			body: row.body,
			user: {login: "agent"},
			created_at: row.createdAt ?? "2026-08-16T03:00:00Z",
			updated_at: row.createdAt ?? "2026-08-16T03:00:00Z",
		})),
	);

const issue = (labels: ReadonlyArray<string>): HttpReply =>
	served({
		number: 5747,
		title: "a lane task",
		body: "",
		state: "open",
		labels: labels.map((name) => ({name})),
		html_url: "https://github.com/o/r/issues/5747",
	});

const run = (
	fs: ReturnType<typeof fakeFs>,
	seams: ReturnType<typeof fakeSeams>,
	event: string,
	classes: ReadonlyArray<string> | null = null,
	pr: string | null = null,
) =>
	Effect.runPromise(
		Effect.provide(
			runProve({
				root: ROOT,
				lane: "5747",
				event,
				task: null,
				classes,
				pr,
				repo: null,
				cwd: "/repo",
				env: {CLAUDE_PIPELINE_REPO: "o/r"},
			}),
			Layer.mergeAll(fs.layer, seams.layer),
		),
	);

describe("lane prove — the two events that carry a claim", () => {
	it("proves a build DONE against the one open PR whose body links the issue", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
		]);

		const out = await run(laneAt("build"), seams, "DONE");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			proof: "proven",
			event: "DONE",
			issue: 5747,
			evidence: {kind: "open-pull", pr: 4318},
		});
	});

	it("proves a review PASS when every derived namespace passes at the live head", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, served([{filename: "packages/fabrika-cli/src/lane/prove.ts"}])],
			[PR_COMMENTS, comments({id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`})],
		]);

		const out = await run(laneAt("review"), seams, "PASS");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			proof: "proven",
			evidence: {kind: "head-verdicts", pr: 4318, head: HEAD},
		});
	});
});

/**
 * Lane 5661's shape (#6112): a reviewer that reported `UNKNOWN` on a malformed criteria heading and
 * then landed three FAILs at head had no cell left for its real terminal, and the ledger read a wait
 * on a human over a PR that needed a repair round. The park is a claim like any other now — that the
 * run reached no verdict — and one FAIL that still binds is what falsifies it.
 */
describe("lane prove — a reviewer's park, refused only by a FAIL that still binds", () => {
	/** The 5661 diff's own shape: a skill file and a package file, so all three namespaces derive. */
	const FIVE_SIX_SIX_ONE = served([
		{filename: "claude-plugins/fabrika/skills/review/SKILL.md"},
		{filename: "packages/fabrika-cli/src/lane/prove.ts"},
	]);

	it("refuses the park lane 5661 recorded, naming every FAIL that still binds at the head", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, FIVE_SIX_SIX_ONE],
			[
				PR_COMMENTS,
				comments(
					{id: 1, body: `governance: FAIL @ ${HEAD} — contradicts an ADR`},
					{id: 2, body: `review-code: FAIL @ ${HEAD} — criteria unmet`},
					{id: 3, body: `review-skill: FAIL @ ${HEAD} — criteria unmet`},
				),
			],
		]);

		const out = await run(laneAt("review"), seams, "BLOCKED");

		expect(out.code).toBe(PROOF_CONTRADICTED);
		expect(out.stderr.join("\n")).toContain(
			"#4318 holds a FAIL that still binds in review-code, review-skill, governance",
		);
		expect(out.stderr.join("\n")).toContain("its terminal is that FAIL and not a park");
	});

	it("lets a park through when the namespaces hold no verdict at all — the ordinary park", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull({comments: 0})],
			[FILES, FIVE_SIX_SIX_ONE],
			[PR_COMMENTS, comments()],
		]);

		const out = await run(laneAt("review"), seams, "BLOCKED");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			proof: "uncontradicted",
			event: "BLOCKED",
			evidence: {kind: "park", pr: 4318},
		});
	});

	/**
	 * The reviewer's own precedence: an unseen input blocks PASS and never FAIL, so a namespace that
	 * passed beside an unreadable one still parks. Only a FAIL is dispatchable.
	 */
	it("lets a park through beside a passing namespace", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, FIVE_SIX_SIX_ONE],
			[PR_COMMENTS, comments({id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`})],
		]);

		const out = await run(laneAt("review"), seams, "BLOCKED");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).proof).toBe("uncontradicted");
	});

	/** A FAIL at another head is not a verdict on this one, so it cannot contradict this run's park. */
	it("lets a park through past a FAIL that no longer binds", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, FIVE_SIX_SIX_ONE],
			[PR_COMMENTS, comments({id: 1, body: `review-code: FAIL @ ${OLD} — criteria unmet`})],
		]);

		const out = await run(laneAt("review"), seams, "BLOCKED");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).proof).toBe("uncontradicted");
	});

	/**
	 * Fail-open, and deliberately: a park routes to a human, the shell reporting it has already
	 * stopped, and there is no later round to re-read in — so holding it on an unreadable board would
	 * strand the lane in the one state nobody could leave.
	 */
	it("records the park when the board cannot be read at all", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, GATEWAY],
		]);

		const out = await run(laneAt("review"), seams, "BLOCKED");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).proof).toBe("uncontradicted");
		expect(out.stderr.join("\n")).toContain("no verdict could contradict the park — it stands");
	});

	it("records the park when the PR is there and its diff is not", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, GATEWAY],
		]);

		const out = await run(laneAt("review"), seams, "BLOCKED");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).proof).toBe("uncontradicted");
		expect(out.stderr.join("\n")).toContain("an unread board leaves it recordable");
	});

	it("records the park when no PR carries the issue's verdicts", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated()],
		]);

		const out = await run(laneAt("review"), seams, "BLOCKED");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).proof).toBe("uncontradicted");
	});

	/** A builder's park is out of `build`, reads nothing, and this arm must not reach it. */
	it("reads nothing for a park out of `build` — the builder's back-off is unchanged", async () => {
		const out = await run(laneAt("build"), fakeSeams([]), "BLOCKED");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({proof: "not-required", state: "build"});
	});
});

describe("lane prove — the ui class, derived exactly as `ship scope` derives it", () => {
	const UI_FILE = served([{filename: "apps/web/src/routes/pano.tsx"}]);

	/**
	 * The deadlock #6664/#6793 closed. This `PASS` **is** the arm into `review:ui`, so requiring
	 * `review-ui` of it required a verdict from the cell it had not entered — every rendered-surface
	 * lane needed a hand-spawned ui reviewer to get out. The next case is the floor that replaces it.
	 */
	it("lets a ui lane's PASS out of `review` through, so the machine can reach `review:ui`", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, UI_FILE],
			[PR_COMMENTS, comments({id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`})],
		]);

		const out = await run(laneAt("review"), seams, "PASS", ["ui"]);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).evidence).toMatchObject({
			namespaces: [{namespace: "review-code", state: "pass", commentId: 1}],
			deferred: ["review-ui"],
		});
		expect(out.stderr.join("\n")).toContain(
			"review-ui on #4318 is owed by the cell this event routes into",
		);
	});

	/**
	 * The floor the deferral must not lift (ADR 0320). Same rendered head, same cell — but no class
	 * relayed, so the machine's `class:ui` arm does not hold and this `PASS` walks to `ship`. There
	 * is no later cell to defer to, so `review-ui` is owed here and the lane is held.
	 */
	it("holds the same PASS when no class is relayed, because the ui arm is not the one it takes", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, UI_FILE],
			[PR_COMMENTS, comments({id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`})],
		]);

		const out = await run(laneAt("review"), seams, "PASS");

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(out.stderr.join("\n")).toContain("review-ui (absent)");
		expect(out.stderr.join("\n")).toContain("routes into no cell that could fill it");
	});

	/**
	 * The other half of the same floor, and the one a class flag cannot talk its way past: a machine
	 * whose `review` cell has no arm into `review:ui` at all — every workflow shape but the coder
	 * template, the shipped `chore` one included. The class stands and the deferral still does not.
	 */
	it("holds a ui-class PASS on a machine whose review cell has no arm into review:ui", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, UI_FILE],
			[PR_COMMENTS, comments({id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`})],
		]);

		const out = await run(laneWithNoUiArm(), seams, "PASS", ["ui"]);

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(out.stderr.join("\n")).toContain("review-ui (absent)");
		expect(out.stderr.join("\n")).toContain("routes into no cell that could fill it");
	});

	it("holds the PASS out of `review:ui` while the lane carries no review-ui verdict", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, UI_FILE],
			[PR_COMMENTS, comments({id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`})],
		]);

		const out = await run(laneAt("review:ui"), seams, "PASS");

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(out.stderr.join("\n")).toContain("review-ui (absent)");
	});

	it("proves the same lane once a head-bound review-ui PASS is on the board", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, UI_FILE],
			[
				PR_COMMENTS,
				comments(
					{id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`},
					{id: 2, body: `review-ui: PASS @ ${HEAD} — the four pillars hold`},
				),
			],
		]);

		const out = await run(laneAt("review:ui"), seams, "PASS");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).evidence.namespaces).toEqual([
			{namespace: "review-code", state: "pass", commentId: 1},
			{namespace: "review-ui", state: "pass", commentId: 2},
		]);
	});

	it("requires no review-ui row of a head that raises no ui class", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, served([{filename: "apps/web/src/routes/pano.test.tsx"}])],
			[PR_COMMENTS, comments({id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`})],
		]);

		const out = await run(laneAt("review"), seams, "PASS");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).evidence.namespaces).toEqual([
			{namespace: "review-code", state: "pass", commentId: 1},
		]);
		expect(JSON.parse(out.stdout).evidence.deferred).toEqual([]);
	});

	it("proves a ui lane whose review-ui is filled by a head-bound routed-elsewhere record", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, UI_FILE],
			[
				PR_COMMENTS,
				comments(
					{id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`},
					{
						id: 2,
						body: `routed-elsewhere: review-ui @ ${HEAD} — nothing under apps/web/src renders differently`,
					},
				),
			],
		]);

		const out = await run(laneAt("review:ui"), seams, "PASS");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).evidence.namespaces).toEqual([
			{namespace: "review-code", state: "pass", commentId: 1},
			{namespace: "review-ui", state: "routed", commentId: 2},
		]);
		expect(out.stderr.join("\n")).toContain("is routed rather than judged");
	});

	it("holds the same lane when the route was attested at a head the branch has moved past", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, UI_FILE],
			[
				PR_COMMENTS,
				comments(
					{id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`},
					{
						id: 2,
						body: "routed-elsewhere: review-ui @ deadbeefcafe — nothing under apps/web/src renders differently",
					},
				),
			],
		]);

		const out = await run(laneAt("review:ui"), seams, "PASS");

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(out.stderr.join("\n")).toContain("review-ui (stale)");
	});

	it("lets a FAIL written after a route win, so a route is no shield", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, UI_FILE],
			[
				PR_COMMENTS,
				comments(
					{id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`},
					{
						id: 2,
						body: `routed-elsewhere: review-ui @ ${HEAD} — nothing under apps/web/src renders differently`,
						createdAt: "2026-01-01T00:00:00Z",
					},
					{
						id: 3,
						body: `review-ui: FAIL @ ${HEAD} — the header contrast broke`,
						createdAt: "2026-01-02T00:00:00Z",
					},
				),
			],
		]);

		const out = await run(laneAt("review:ui"), seams, "PASS");

		expect(out.code).toBe(PROOF_CONTRADICTED);
		expect(out.stderr.join("\n")).toContain("review-ui");
	});
});

describe("lane prove — the refusals, each on its own remedy", () => {
	it("refuses a build DONE with no open PR and no no-PR outcome, naming what it looked for", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated()],
			[ISSUE, issue(["type:feature"])],
			[ISSUE_COMMENTS, comments()],
		]);

		const out = await run(laneAt("build"), seams, "DONE");

		expect(out.code).toBe(PROOF_ABSENT);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("whose body links #5747");
		expect(out.stderr.join("\n")).toContain("type:investigation");
	});

	it("refuses a build DONE when several open PRs link the issue", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318, 4319)],
			[PULL, pull()],
			[/^GET .*\/repos\/o\/r\/pulls\/4319$/, pull({number: 4319})],
		]);

		const out = await run(laneAt("build"), seams, "DONE");

		expect(out.code).toBe(PROOF_AMBIGUOUS);
		expect(out.stderr.join("\n")).toContain("#4318, #4319");
	});

	it("refuses a PASS while a derived namespace has no current-head verdict", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, served([{filename: "claude-plugins/fabrika/skills/operate/SKILL.md"}])],
			[PR_COMMENTS, comments({id: 1, body: `review-skill: PASS @ ${HEAD} — reads clean`})],
		]);

		const out = await run(laneAt("review"), seams, "PASS");

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(out.stderr.join("\n")).toContain("governance (absent)");
	});

	it("refuses a PASS whose namespace verdict is at a head the PR has moved past", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, served([{filename: "packages/fabrika-cli/src/lane/prove.ts"}])],
			[PR_COMMENTS, comments({id: 1, body: `review-code: PASS @ ${OLD} — merge-ready`})],
		]);

		const out = await run(laneAt("review"), seams, "PASS");

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(out.stderr.join("\n")).toContain("review-code (stale)");
	});

	it("refuses a PASS the board contradicts with a current-head FAIL", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, served([{filename: "packages/fabrika-cli/src/lane/prove.ts"}])],
			[PR_COMMENTS, comments({id: 1, body: `review-code: FAIL @ ${HEAD} — the fold drops a row`})],
		]);

		const out = await run(laneAt("review"), seams, "PASS");

		expect(out.code).toBe(PROOF_CONTRADICTED);
		expect(out.stderr.join("\n")).toContain("FAIL");
	});

	it("leaves the proof UNKNOWN when a board read fails — never proven, never absent", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, GATEWAY],
		]);

		const out = await run(laneAt("build"), seams, "DONE");

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("leaves the proof UNKNOWN when the closing-issue edge fails, before any search", async () => {
		const seams = fakeSeams([[CLOSERS, GATEWAY]]);

		const out = await run(laneAt("build"), seams, "DONE");

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stderr.join("\n")).toContain("closing #5747");
		expect(seams.requests.some((line) => SEARCH.test(line))).toBe(false);
	});
});

describe("lane prove — the union of the two nomination reads", () => {
	it("proves a DONE off the closing edge while the search index still lags the fresh PR", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls(4318)],
			[SEARCH, nominated()],
			[PULL, pull()],
		]);

		const out = await run(laneAt("build"), seams, "DONE");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({evidence: {kind: "open-pull", pr: 4318}});
	});

	it("proves a DONE off the search nomination for a Part of PR the closing edge cannot see", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull({body: "Part of #5747\n\n## Deviations\nNone.\n"})],
		]);

		const out = await run(laneAt("build"), seams, "DONE");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({evidence: {kind: "open-pull", pr: 4318}});
	});

	it("counts a PR both reads nominate once, so agreement is not ambiguity", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls(4318)],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
		]);

		const out = await run(laneAt("build"), seams, "DONE");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({evidence: {kind: "open-pull", pr: 4318}});
		expect(seams.requests.filter((line) => PULL.test(line))).toHaveLength(1);
	});
});

describe("lane prove — the §CP advisory carrier (ADR 0111/0226)", () => {
	const CODEOWNERS = /^GET \S+\/repos\/o\/r\/contents\/\.github\/CODEOWNERS\?ref=main$/;
	const CONFIG = /^GET \S+\/repos\/o\/r\/contents\/\.fabrika\.jsonc\?ref=main$/;
	const advisory = (rows = ""): string =>
		`review-code: advisory — merge stays human-gated\n${rows}\nReviewed-head: @ ${HEAD}\n`;
	const codeFile = served([{filename: "packages/fabrika-cli/src/lane/prove.ts"}]);

	it("proves a review PASS carried by an advisory when the diff classifies control-plane", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, codeFile],
			[PR_COMMENTS, comments({id: 1, body: advisory()})],
			[CODEOWNERS, {status: 200, body: "/packages/fabrika-cli/ @kamp-us/control-plane\n"}],
		]);

		const out = await run(laneAt("review"), seams, "PASS");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			proof: "proven",
			evidence: {kind: "head-verdicts", pr: 4318, head: HEAD},
		});
		expect(out.stderr.join("\n")).toContain("advisory-carried");
	});

	it("still rows a marker-less comment absent when the diff is not control-plane", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, codeFile],
			[PR_COMMENTS, comments({id: 1, body: advisory()})],
			[CODEOWNERS, {status: 200, body: "/claude-plugins/ @kamp-us/control-plane\n"}],
		]);

		const out = await run(laneAt("review"), seams, "PASS");

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(out.stderr.join("\n")).toContain("review-code (absent)");
		expect(out.stderr.join("\n")).toContain("not-control-plane");
	});

	it("reads a [FAIL] row inside an advisory as fail, never as a pass", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, codeFile],
			[PR_COMMENTS, comments({id: 1, body: advisory("\n- [FAIL] the guard is bypassed\n")})],
			[CODEOWNERS, {status: 200, body: "/packages/fabrika-cli/ @kamp-us/control-plane\n"}],
		]);

		const out = await run(laneAt("review"), seams, "PASS");

		expect(out.code).toBe(PROOF_CONTRADICTED);
		expect(out.stderr.join("\n")).toContain("invalid emission (ADR 0226)");
	});

	it("refuses an advisory bound to a head the PR has moved past as in-flight, not proven", async () => {
		const stale = `review-code: advisory — merge stays human-gated\n\nReviewed-head: @ ${OLD}\n`;
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, codeFile],
			[PR_COMMENTS, comments({id: 1, body: stale})],
			[CODEOWNERS, {status: 200, body: "/packages/fabrika-cli/ @kamp-us/control-plane\n"}],
		]);

		const out = await run(laneAt("review"), seams, "PASS");

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(out.stderr.join("\n")).toContain("review-code (stale)");
	});

	it("leaves the proof UNKNOWN when the boundary itself cannot be read", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, codeFile],
			[PR_COMMENTS, comments({id: 1, body: advisory()})],
			[CODEOWNERS, {status: 502, body: '{"message":"Bad Gateway"}'}],
		]);

		const out = await run(laneAt("review"), seams, "PASS");

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stderr.join("\n")).toContain(".github/CODEOWNERS");
	});

	it("still refuses a failed boundary read when the repo's config says ship (ADR 0220 §4)", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, codeFile],
			[PR_COMMENTS, comments({id: 1, body: advisory()})],
			[CODEOWNERS, {status: 502, body: '{"message":"Bad Gateway"}'}],
			[CONFIG, {status: 200, body: '{"unreadableCodeowners": "ship"}'}],
		]);

		const out = await run(laneAt("review"), seams, "PASS");

		expect(out.code).toBe(LANE_UNREADABLE);
	});

	it("never reads the boundary while no comment reaches for the advisory carrier", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
			[FILES, codeFile],
			[PR_COMMENTS, comments({id: 1, body: "looks good to me"})],
		]);

		const out = await run(laneAt("review"), seams, "PASS");

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(seams.requests.some((line) => CODEOWNERS.test(line))).toBe(false);
	});
});

describe("lane prove — what it does not claim, and what it never writes", () => {
	it("answers not-required for an event no board read can falsify, reading nothing", async () => {
		const seams = fakeSeams([]);
		const fs = laneAt("build");

		const out = await run(fs, seams, "BLOCKED");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({proof: "not-required", state: "build"});
		expect(seams.log).toEqual([]);
	});

	it("proves a no-PR builder outcome from the investigation label and its diagnosis", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated()],
			[ISSUE, issue(["type:investigation"])],
			[
				ISSUE_COMMENTS,
				comments({id: 900, body: "the loader races the fold", createdAt: "2026-08-16T04:00:00Z"}),
			],
		]);

		const out = await run(laneAt("build"), seams, "DONE");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			proof: "proven",
			evidence: {kind: "diagnosis", commentId: 900},
		});
	});

	it("refuses a no-PR DONE whose only comment predates the build", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated()],
			[ISSUE, issue(["type:investigation"])],
			[ISSUE_COMMENTS, comments({id: 900, body: "triaged", createdAt: "2026-08-16T00:30:00Z"})],
		]);

		const out = await run(laneAt("build"), seams, "DONE");

		expect(out.code).toBe(PROOF_ABSENT);
	});

	it("writes nothing on any path — the ledger append stays lane transition's (single-issue)", async () => {
		const fs = laneAt("build");
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull()],
		]);

		await run(fs, seams, "DONE");

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
	seams: ReturnType<typeof fakeSeams>,
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
				classes: null,
				pr: null,
				repo: null,
				cwd: "/repo",
				env: {CLAUDE_PIPELINE_REPO: "o/r"},
			}),
			Layer.mergeAll(fs.layer, seams.layer),
		),
	);

/** A ref name is matched literally, so `build/pr-1` never reaches the engine as a pattern. */
const literally = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const REV = (rev: string) =>
	new RegExp(`^git rev-parse --verify --quiet ${literally(rev)}\\^\\{commit\\}$`);
const BRANCHES = /^git for-each-ref --format=%\(refname:short\) refs\/heads$/;
/** The shallow probe every range read takes before it trusts an ancestry answer (#6343). */
const COMPLETE_CLONE = [/^git rev-parse --is-shallow-repository$/, okOut("false\n")] as const;
const LOG_RANGE = /^git log --format=/;
const MERGE_BASE = /^git merge-base /;
const ANCESTRY = /^git rev-list --parents --ancestry-path /;
const RAW = /^git diff .* --raw --abbrev=40 -z /;
const CHILD_COMMENTS = /^GET .*\/repos\/o\/r\/issues\/4301\/comments\?/;

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

/** The same child range, plus one path under a governance root — `code` class, `governance` floor. */
const GOVERNED_RAW = CHILD_RAW + rawRecord(".github/workflows/ci.yml");
const GOVERNED_DIGEST = digestOf(GOVERNED_RAW);

/** The same child range, plus one rendered frontend surface — the `ui` class beside `code`. */
const UI_RAW = CHILD_RAW + rawRecord("apps/web/src/routes/pano.tsx");
const UI_DIGEST = digestOf(UI_RAW);

/** The git reads that locate the one child branch and the range it adds. */
const locating = (
	branches: ReadonlyArray<string> = [CHILD_BRANCH, "main", "epic/4300"],
	commits: ReadonlyArray<readonly [string, string]> = [[CHILD_TIP, CHILD_MESSAGE]],
): ReadonlyArray<Scripted> => [
	COMPLETE_CLONE,
	[REV("epic/4300"), okOut(`${EPIC_BASE}\n`)],
	[BRANCHES, okOut(`${branches.join("\n")}\n`)],
	[REV(CHILD_BRANCH), okOut(`${CHILD_TIP}\n`)],
	[/^git rev-parse --verify --quiet build\//, okOut(`${CHILD_TIP}\n`)],
	// The child is not integrated here, so the fork point is where the epic branch stands.
	[MERGE_BASE, okOut(`${EPIC_BASE}\n`)],
	[LOG_RANGE, logOf(...commits)],
];

/** A 40-hex object name from a short seed, so a fixture SHA reads as the thing it stands for. */
const sha = (seed: string): string => seed.repeat(40).slice(0, 40);

/** Where the child branch left the epic branch — the base its reviewer was handed. */
const FORK = sha("664eb9dc");
/** The epic branch after a sibling, and then this child, landed on it. */
const EPIC_MOVED = sha("ec3894d3");
/** The epic branch as it stood the instant before this child's integrating merge. */
const EPIC_BEFORE = sha("d67022dc");

const rangeMarker = (
	polarity: "PASS" | "FAIL",
	content: string,
	base = EPIC_BASE.slice(0, 7),
	tip = CHILD_TIP.slice(0, 7),
	namespace = "review-code",
): string =>
	`${namespace}: ${polarity} range:${base}..${tip} content:${content} — every criterion met`;

describe("lane prove — an epic child's DONE stands on commits, never on a PR", () => {
	it("proves a child DONE from the commits its branch adds over the epic branch", async () => {
		const seams = fakeSeams([...locating()]);

		const out = await runEpic(epicLaneAt("build"), seams, "DONE", "issue_4301");

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
				naming: 1,
			},
		});
		expect(seams.requests).toEqual([]);
	});

	it("reports the range's size and its naming commits as the two numbers they are", async () => {
		const seams = fakeSeams([
			...locating(
				[CHILD_BRANCH, "main", "epic/4300"],
				[
					[CHILD_TIP, CHILD_MESSAGE],
					["2222222222222222222222222222222222222222", "feat(lane): groundwork, no issue named"],
				],
			),
		]);

		const out = await runEpic(epicLaneAt("build"), seams, "DONE", "issue_4301");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).evidence).toMatchObject({commits: 2, naming: 1});
		expect(out.stderr.join("\n")).toContain("adds 2 commit(s), 1 of them naming #4301");
	});

	it("proves a child DONE after its commits have landed on the epic branch", async () => {
		// The merge base of a contained tip IS that tip, so the range only survives integration if the
		// verb recovers the epic branch as it stood before the merge that took the child in (#5984).
		const seams = fakeSeams([
			COMPLETE_CLONE,
			[REV("epic/4300"), okOut(`${EPIC_MOVED}\n`)],
			[BRANCHES, okOut(`${CHILD_BRANCH}\n`)],
			[/^git rev-parse --verify --quiet build\//, okOut(`${CHILD_TIP}\n`)],
			[new RegExp(`^git merge-base ${EPIC_MOVED} ${CHILD_TIP}$`), okOut(`${CHILD_TIP}\n`)],
			[ANCESTRY, okOut(`${EPIC_MOVED} ${EPIC_BEFORE} ${CHILD_TIP}\n`)],
			[new RegExp(`^git merge-base ${EPIC_BEFORE} ${CHILD_TIP}$`), okOut(`${FORK}\n`)],
			[LOG_RANGE, logOf([CHILD_TIP, CHILD_MESSAGE])],
		]);

		const out = await runEpic(epicLaneAt("build"), seams, "DONE", "issue_4301");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).evidence).toMatchObject({
			range: {base: FORK, tip: CHILD_TIP},
			commits: 1,
			naming: 1,
		});
	});

	it("measures a not-yet-integrated child over its fork point, not over the moved epic tip", async () => {
		const seams = fakeSeams([
			COMPLETE_CLONE,
			[REV("epic/4300"), okOut(`${EPIC_MOVED}\n`)],
			[BRANCHES, okOut(`${CHILD_BRANCH}\n`)],
			[/^git rev-parse --verify --quiet build\//, okOut(`${CHILD_TIP}\n`)],
			[MERGE_BASE, okOut(`${FORK}\n`)],
			[LOG_RANGE, logOf([CHILD_TIP, CHILD_MESSAGE])],
		]);

		const out = await runEpic(epicLaneAt("build"), seams, "DONE", "issue_4301");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).evidence).toMatchObject({range: {base: FORK, tip: CHILD_TIP}});
		expect(seams.calls.some((line) => line.includes(`${FORK}..${CHILD_TIP}`))).toBe(true);
		expect(seams.calls.some((line) => ANCESTRY.test(line))).toBe(false);
	});

	it("refuses a child DONE whose branch was cut and never built on", async () => {
		const seams = fakeSeams([...locating([CHILD_BRANCH], [])]);

		const out = await runEpic(epicLaneAt("build"), seams, "DONE", "issue_4301");

		expect(out.code).toBe(PROOF_ABSENT);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("cut and not built on");
	});

	it("still refuses a never-built branch whose tip a sibling's merge names as first parent", async () => {
		// The tip is an epic commit, so it is contained and a later merge names it — as its FIRST
		// parent. Reading the second there would hand back a sibling's fork point and prove nothing.
		const seams = fakeSeams([
			COMPLETE_CLONE,
			[REV("epic/4300"), okOut(`${EPIC_MOVED}\n`)],
			[BRANCHES, okOut(`${CHILD_BRANCH}\n`)],
			[/^git rev-parse --verify --quiet build\//, okOut(`${CHILD_TIP}\n`)],
			[new RegExp(`^git merge-base ${EPIC_MOVED} ${CHILD_TIP}$`), okOut(`${CHILD_TIP}\n`)],
			[ANCESTRY, okOut(`${EPIC_MOVED} ${CHILD_TIP} ${sha("5b1b1a9c")}\n`)],
			[LOG_RANGE, logOf()],
		]);

		const out = await runEpic(epicLaneAt("build"), seams, "DONE", "issue_4301");

		expect(out.code).toBe(PROOF_ABSENT);
		expect(out.stderr.join("\n")).toContain("cut and not built on");
		expect(seams.calls.some((line) => line.startsWith(`git merge-base ${sha("5b1b1a9c")}`))).toBe(
			false,
		);
	});

	it("refuses a child DONE when the branch carries only another child's commits", async () => {
		const seams = fakeSeams([
			...locating([CHILD_BRANCH], [[CHILD_TIP, "feat(lane): another child (#4302)"]]),
		]);

		const out = await runEpic(epicLaneAt("build"), seams, "DONE", "issue_4301");

		expect(out.code).toBe(PROOF_ABSENT);
		expect(out.stderr.join("\n")).toContain("names #4301");
	});

	it("refuses a child DONE when two lane branches both carry its commits", async () => {
		const seams = fakeSeams([
			COMPLETE_CLONE,
			[REV("epic/4300"), okOut(`${EPIC_BASE}\n`)],
			[BRANCHES, okOut(`${CHILD_BRANCH}\nbuild/4301-second-try-deadbeef\n`)],
			[/^git rev-parse --verify --quiet build\//, okOut(`${CHILD_TIP}\n`)],
			[MERGE_BASE, okOut(`${EPIC_BASE}\n`)],
			[LOG_RANGE, logOf([CHILD_TIP, CHILD_MESSAGE])],
		]);

		const out = await runEpic(epicLaneAt("build"), seams, "DONE", "issue_4301");

		expect(out.code).toBe(PROOF_AMBIGUOUS);
		expect(out.stderr.join("\n")).toContain("build/4301-second-try-deadbeef");
	});

	it("leaves a child DONE UNKNOWN when the epic branch is not in this tree", async () => {
		const seams = fakeSeams([[REV("epic/4300"), errOut("unknown revision")]]);

		const out = await runEpic(epicLaneAt("build"), seams, "DONE", "issue_4301");

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stderr.join("\n")).toContain("UNKNOWN");
		expect(seams.calls.some((line) => BRANCHES.test(line))).toBe(false);
	});

	it("leaves a child DONE UNKNOWN when the range's base sits on a shallow graft boundary", async () => {
		const seams = fakeSeams([
			[/^git rev-parse --is-shallow-repository$/, okOut("true\n")],
			[REV("epic/4300"), okOut(`${EPIC_BASE}\n`)],
			[/^git log -1 --format=%P /, okOut("\n")],
		]);

		const out = await runEpic(epicLaneAt("build"), seams, "DONE", "issue_4301");

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stderr.join("\n")).toContain("git fetch --deepen=25");
		expect(seams.calls.some((line) => BRANCHES.test(line))).toBe(false);
	});

	it("answers not-required for the DONE that lands a reviewed range, reading nothing", async () => {
		const seams = fakeSeams([]);
		const fs = fakeFs({
			files: {
				[EPIC_WORKFLOW]: epicWorkflowText(),
				[EPIC_LOG]:
					epicLine("issue_4301", "WIP", "2026-08-16T01:00:00Z") +
					epicLine("issue_4301", "DONE", "2026-08-16T02:00:00Z") +
					epicLine("issue_4301", "PASS", "2026-08-16T03:00:00Z"),
			},
		});

		const out = await runEpic(fs, seams, "DONE", "issue_4301");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({proof: "not-required", state: "integrate"});
		expect(seams.log).toEqual([]);
	});
});

describe("lane prove — an epic child's PASS stands on a range verdict that still binds", () => {
	const proving = (...comments: ReadonlyArray<{id: number; body: string}>) =>
		fakeSeams([...locating(), [RAW, okOut(CHILD_RAW)], [CHILD_COMMENTS, comments_(comments)]]);

	const comments_ = (rows: ReadonlyArray<{id: number; body: string}>): HttpReply =>
		served(
			rows.map((row) => ({
				id: row.id,
				body: row.body,
				user: {login: "agent"},
				created_at: "2026-08-16T03:00:00Z",
				updated_at: "2026-08-16T03:00:00Z",
			})),
		);

	it("proves a child PASS whose verdict binds the content this range carries now", async () => {
		const seams = proving({id: 1, body: rangeMarker("PASS", CHILD_DIGEST)});

		const out = await runEpic(epicLaneAt("review"), seams, "PASS", "issue_4301");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			proof: "proven",
			event: "PASS",
			issue: 4301,
			evidence: {kind: "range-verdicts", epic: 4300, content: CHILD_DIGEST},
		});
	});

	it("digests the range the reviewer measured once the child has been integrated", async () => {
		// The binding is content and only content (ADR 0276), so an integrated child's PASS reads
		// `Current` only while prove diffs the same two endpoints the marker was posted over (#5984).
		const seams = fakeSeams([
			COMPLETE_CLONE,
			[REV("epic/4300"), okOut(`${EPIC_MOVED}\n`)],
			[BRANCHES, okOut(`${CHILD_BRANCH}\n`)],
			[/^git rev-parse --verify --quiet build\//, okOut(`${CHILD_TIP}\n`)],
			[new RegExp(`^git merge-base ${EPIC_MOVED} ${CHILD_TIP}$`), okOut(`${CHILD_TIP}\n`)],
			[ANCESTRY, okOut(`${EPIC_MOVED} ${EPIC_BEFORE} ${CHILD_TIP}\n`)],
			[new RegExp(`^git merge-base ${EPIC_BEFORE} ${CHILD_TIP}$`), okOut(`${FORK}\n`)],
			[LOG_RANGE, logOf([CHILD_TIP, CHILD_MESSAGE])],
			[RAW, okOut(CHILD_RAW)],
			[CHILD_COMMENTS, comments_([{id: 1, body: rangeMarker("PASS", CHILD_DIGEST)}])],
		]);

		const out = await runEpic(epicLaneAt("review"), seams, "PASS", "issue_4301");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).evidence).toMatchObject({
			range: {base: FORK, tip: CHILD_TIP},
			content: CHILD_DIGEST,
		});
		expect(seams.calls.some((line) => RAW.test(line) && line.includes(FORK))).toBe(true);
	});

	it("refuses a child PASS with no verdict at all on the child issue", async () => {
		const seams = proving({id: 1, body: "looks good to me"});

		const out = await runEpic(epicLaneAt("review"), seams, "PASS", "issue_4301");

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(out.stderr.join("\n")).toContain("review-code (absent)");
	});

	// The append the range path lands (#7411) is the shape this reader meets on every repair round:
	// one comment carrying the live verdict on its first line and every retired one below the fence.
	// The marker walk takes the first non-blank line, so the fresh verdict is the one in force — a
	// reader that scanned the whole body would find the archived FAIL and contradict a passing child.
	it("reads the live verdict off a comment carrying a superseded archive, not the retired one", async () => {
		const retired = `${rangeMarker("FAIL", CHILD_DIGEST)}\n\nthe round that blocked\n`;
		const fresh = `${rangeMarker("PASS", CHILD_DIGEST)}\n\nevery criterion met now\n`;
		const seams = proving({
			id: 1,
			body: supersedeWith(retired, fresh, new Date("2026-09-01T00:00:00Z")),
		});

		const out = await runEpic(epicLaneAt("review"), seams, "PASS", "issue_4301");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({proof: "proven", event: "PASS", issue: 4301});
	});

	it("still contradicts when the appended verdict is the FAIL and the archive holds the PASS", async () => {
		const retired = `${rangeMarker("PASS", CHILD_DIGEST)}\n\nthe round that passed\n`;
		const fresh = `${rangeMarker("FAIL", CHILD_DIGEST)}\n\na criterion regressed\n`;
		const seams = proving({
			id: 1,
			body: supersedeWith(retired, fresh, new Date("2026-09-01T00:00:00Z")),
		});

		const out = await runEpic(epicLaneAt("review"), seams, "PASS", "issue_4301");

		expect(out.code).toBe(PROOF_CONTRADICTED);
		expect(out.stderr.join("\n")).toContain("FAIL");
	});

	it("refuses a child PASS whose verdict binds a digest the range has moved past", async () => {
		const seams = proving({id: 1, body: rangeMarker("PASS", "2f1a9c4e0b7d")});

		const out = await runEpic(epicLaneAt("review"), seams, "PASS", "issue_4301");

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(out.stderr.join("\n")).toContain("review-code (stale)");
	});

	it("refuses a child PASS whose verdict was written over another range's content", async () => {
		const seams = proving({
			id: 1,
			body: rangeMarker("PASS", OTHER_DIGEST, "aaaaaaa", "bbbbbbb"),
		});

		const out = await runEpic(epicLaneAt("review"), seams, "PASS", "issue_4301");

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(out.stderr.join("\n")).toContain("review-code (stale)");
		expect(out.stderr.join("\n")).toContain("over range aaaaaaa..bbbbbbb");
	});

	it("refuses a child PASS the child issue contradicts with a range FAIL", async () => {
		const seams = proving({id: 1, body: rangeMarker("FAIL", CHILD_DIGEST)});

		const out = await runEpic(epicLaneAt("review"), seams, "PASS", "issue_4301");

		expect(out.code).toBe(PROOF_CONTRADICTED);
		expect(out.stderr.join("\n")).toContain("FAIL");
	});

	it("names a PR-scoped marker posted on the child issue instead of reading it as no verdict", async () => {
		const seams = proving({id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`});

		const out = await runEpic(epicLaneAt("review"), seams, "PASS", "issue_4301");

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(out.stderr.join("\n")).toContain("is not a range one");
	});

	const governedBy = (...comments: ReadonlyArray<{id: number; body: string}>) =>
		fakeSeams([...locating(), [RAW, okOut(GOVERNED_RAW)], [CHILD_COMMENTS, comments_(comments)]]);

	it("refuses a child PASS whose range touches a governance root and carries no governance verdict", async () => {
		const seams = governedBy({id: 1, body: rangeMarker("PASS", GOVERNED_DIGEST)});

		const out = await runEpic(epicLaneAt("review"), seams, "PASS", "issue_4301");

		expect(out.code).toBe(PROOF_IN_FLIGHT);
		expect(out.stderr.join("\n")).toContain("derives review-code, governance");
		expect(out.stderr.join("\n")).toContain("governance (absent)");
		expect(out.stderr.join("\n")).not.toContain("review-code (absent)");
	});

	it("proves that same governed child PASS once the governance range verdict is on the issue", async () => {
		const seams = governedBy(
			{id: 1, body: rangeMarker("PASS", GOVERNED_DIGEST)},
			{
				id: 2,
				body: rangeMarker(
					"PASS",
					GOVERNED_DIGEST,
					EPIC_BASE.slice(0, 7),
					CHILD_TIP.slice(0, 7),
					"governance",
				),
			},
		);

		const out = await runEpic(epicLaneAt("review"), seams, "PASS", "issue_4301");

		expect(out.code).toBe(0);
		expect(
			JSON.parse(out.stdout).evidence.namespaces.map((row: {namespace: string}) => row.namespace),
		).toEqual(["review-code", "governance"]);
	});

	const uiRanged = (...comments: ReadonlyArray<{id: number; body: string}>) =>
		fakeSeams([...locating(), [RAW, okOut(UI_RAW)], [CHILD_COMMENTS, comments_(comments)]]);

	/**
	 * The deadlock #7041 closed, and the other seam of the one #6664 closed for a single lane. No
	 * cell of a child's region routes to `review:ui` and no verb of this CLI posts `review-ui` at
	 * range scope, so requiring it of a ui-bearing child asked for a verdict nothing could ever
	 * write — epic #6767's tracer C sat at exit 23 until a human integrated it by hand. The bar is
	 * not dropped: it moves to the tail, whose one PR carries these same rendered files.
	 */
	it("proves a ui child's PASS with no review-ui verdict at child scope at all", async () => {
		const seams = uiRanged({id: 1, body: rangeMarker("PASS", UI_DIGEST)});

		const out = await runEpic(epicLaneAt("review"), seams, "PASS", "issue_4301");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).evidence).toMatchObject({
			namespaces: [{namespace: "review-code", state: "pass", commentId: 1}],
			deferred: ["review-ui"],
		});
		expect(out.stderr.join("\n")).toContain("derives review-code, review-ui");
		expect(out.stderr.join("\n")).toContain("review-ui is owed by epic #4300's tail");
	});

	/**
	 * The deferral is the child's shape, not a fallback for a missing record, so a `review-ui`
	 * comment at child scope changes nothing either way — including one bound to a tip the branch has
	 * moved past, which under the old bar refused the whole PASS.
	 */
	it("reads no review-ui record at child scope, current or stale, because it is the tail's", async () => {
		for (const at of [CHILD_TIP, EPIC_BASE]) {
			const seams = uiRanged(
				{id: 1, body: rangeMarker("PASS", UI_DIGEST)},
				{
					id: 2,
					body: `routed-elsewhere: review-ui @ ${at} — nothing this range touches renders differently`,
				},
			);

			const out = await runEpic(epicLaneAt("review"), seams, "PASS", "issue_4301");

			expect(out.code).toBe(0);
			expect(JSON.parse(out.stdout).evidence.namespaces).toEqual([
				{namespace: "review-code", state: "pass", commentId: 1},
			]);
			expect(out.stderr.join("\n")).not.toContain("is routed rather than judged");
		}
	});

	/** Criterion 3 of #7041: a child whose range renders nothing derives no `review-ui` to subtract. */
	it("defers nothing on a child whose range raises no ui class", async () => {
		const seams = proving({id: 1, body: rangeMarker("PASS", CHILD_DIGEST)});

		const out = await runEpic(epicLaneAt("review"), seams, "PASS", "issue_4301");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).evidence.deferred).toEqual([]);
		expect(out.stderr.join("\n")).not.toContain("is owed by epic");
	});

	it("leaves a child PASS UNKNOWN when the range's own content cannot be read", async () => {
		const seams = fakeSeams([...locating(), [RAW, errOut("fatal: bad object")]]);

		const out = await runEpic(epicLaneAt("review"), seams, "PASS", "issue_4301");

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stderr.join("\n")).toContain("UNKNOWN");
	});
});

describe("lane prove — the epic tail keeps the PR arms", () => {
	it("proves the tail PASS off the one PR's current-head verdicts, reading no range", async () => {
		const seams = fakeSeams([
			[CLOSERS, closingPulls()],
			[SEARCH, nominated(4318)],
			[PULL, pull({body: "Fixes #4300\n\n## Deviations\nNone.\n"})],
			[FILES, served([{filename: "packages/fabrika-cli/src/lane/prove.ts"}])],
			[PR_COMMENTS, comments({id: 1, body: `review-code: PASS @ ${HEAD} — merge-ready`})],
		]);

		const out = await runEpic(epicLaneAt("tail"), seams, "PASS", "epic_4300");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			proof: "proven",
			issue: 4300,
			evidence: {kind: "head-verdicts", pr: 4318, head: HEAD},
		});
		expect(seams.calls.some((line) => BRANCHES.test(line))).toBe(false);
	});
});

/**
 * The ship stage's closure read, off the PR the event names (#7457).
 *
 * Every board here stubs **both** nomination reads to return nothing, which is what production
 * looks like for the case ADR 0343 exists to catch: a merged `Part of #N` is a node in neither half
 * of the union. So an arm that answers at all answers off the named PR, and the `Partial` arm that
 * could never fire while the nominator was the reader now does.
 */
describe("lane prove — the ship stage's closure, read off the PR the event names", () => {
	const shipLane = () =>
		fakeFs({
			files: {
				[WORKFLOW]: coderTemplateText(),
				[LOG]:
					logLine("WIP", "2026-08-16T01:00:00Z") +
					logLine("DONE", "2026-08-16T02:00:00Z") +
					logLine("PASS", "2026-08-16T03:00:00Z"),
			},
		});

	const blindNominator: ReadonlyArray<Scripted> = [
		[CLOSERS, closingPulls()],
		[SEARCH, nominated()],
	];

	const merged = (body: string): HttpReply =>
		pull({state: "closed", merged: true, body: `${body}\n\n## Deviations\nNone.\n`});

	const PR_URL = "https://github.com/o/r/pull/4318";

	it("answers `partial` for a merged body carrying `Part of #N` and no closing keyword", async () => {
		const seams = fakeSeams([...blindNominator, [PULL, merged("Part of #5747")]]);

		const out = await run(shipLane(), seams, "DONE", null, PR_URL);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({issue: 5747, state: "ship", closure: "partial"});
		expect(out.partial).toBe(true);
	});

	it("answers `closes` for a merged body carrying a closing keyword", async () => {
		const seams = fakeSeams([...blindNominator, [PULL, merged("Fixes #5747")]]);

		const out = await run(shipLane(), seams, "DONE", null, PR_URL);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({closure: "closes"});
		expect(out.partial).toBe(false);
	});

	it("answers `unknown` with no `partial` where the event names no PR", async () => {
		const seams = fakeSeams(blindNominator);

		const out = await run(shipLane(), seams, "DONE");

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({closure: "unknown"});
		expect(out.partial).toBe(null);
	});

	/**
	 * An unread board no longer refuses the terminal. Recording the `DONE` with no `partial` leaves
	 * the line nominable by `lane reconcile`, where a refusal would strand the shipper over a merge
	 * that really landed (ADR 0351).
	 */
	it("answers `unknown` with no `partial` where the PR read fails", async () => {
		const seams = fakeSeams([...blindNominator, [PULL, GATEWAY]]);

		const out = await run(shipLane(), seams, "DONE", null, PR_URL);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({closure: "unknown"});
		expect(out.partial).toBe(null);
	});
});
