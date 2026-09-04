/**
 * The canned payloads the `recipe` verb tests script their spawner and their filesystem with.
 *
 * The PR shape itself is `ship/fixtures.test-support.ts`'s — the §CP clearance is that group's verb
 * relayed, so a second PR fixture here would let the two disagree about what the platform returns.
 */
import type {HttpReply} from "../fakes.test-support.ts";
import {okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {coderTemplateText} from "../lane/fixtures.test-support.ts";
import {WAIT_BUDGET} from "../wait-budget.ts";

export const LANES_ROOT = ".fabrika/lanes";

/** The lane the fixtures drive: the `ship` fixtures' issue, whose PR is their #4321. */
export const LANE = "4287";
export const WORKFLOW = `${LANES_ROOT}/${LANE}/workflow.json`;
export const LOG = `${LANES_ROOT}/${LANE}/events.jsonl`;

export const laneTemplate = coderTemplateText;

/** An `events.jsonl` that folds the coder lane into each named state. */
export const eventLog = (...events: ReadonlyArray<string>): string =>
	events
		.map(
			(event, index) =>
				`${JSON.stringify({
					task: "issue",
					event: `ISSUE.${event}`,
					at: `2026-08-16T00:0${index}:00.000Z`,
				})}\n`,
		)
		.join("");

/** queued → build → review → ship → human:cp-approval, the park the §CP recipe clears. */
export const PARKED_AT_CP = eventLog("WIP", "DONE", "PASS", "BLOCKED");

/**
 * queued → … → ship, then a dwell that spends the whole wait budget — the #6717 park.
 *
 * The first `WIP` out of `ship` is unguarded, so it takes `WAIT_BUDGET` more to spend the budget and
 * one beyond that to fall through into the stall.
 */
export const PARKED_AT_QUEUE_STALL = eventLog(
	"WIP",
	"DONE",
	"PASS",
	...Array.from({length: WAIT_BUDGET + 2}, () => "WIP"),
);

/** queued → blocked, the bare park no fixed fix keys on. */
export const PARKED_BLOCKED = eventLog("BLOCKED");

/**
 * queued → build → blocked, with a `cause` on the parking line — what a shell's `--cause` records.
 *
 * Parked out of `build` rather than `queued`, because that is where the #6395 park is actually
 * taken: the builder's `build branch --resume-lane` refuses, so the history state `UNBLOCKED` walks
 * back into is `build`.
 */
export const parkedBlockedOn = (cause: string): string =>
	eventLog("WIP") +
	`${JSON.stringify({
		task: "issue",
		event: "ISSUE.BLOCKED",
		at: "2026-08-16T00:01:00.000Z",
		cause,
	})}\n`;

/** The #6395 park: BLOCKED because a working tree still held the lane branch. */
export const PARKED_ON_WORKTREE = parkedBlockedOn("worktree-holds-branch");

/** The #7217 park: BLOCKED because the campaign homing the lane's milestone read `paused`. */
export const PARKED_ON_CAMPAIGN = parkedBlockedOn("campaign-paused");

/** The #6770 park: BLOCKED because the provider killed the shell before it reported a terminal. */
export const PARKED_ON_SPAWN = parkedBlockedOn("spawn-dead");

/** The milestone {@link LANE}'s issue is homed on, and the one a campaign row pins. */
export const LANE_MILESTONE = 49;

export interface CampaignFixtureRow {
	readonly name: string;
	readonly milestone: number;
	readonly state: string;
}

/**
 * A `ROADMAP.md` whose `## Campaigns` table holds exactly `rows`.
 *
 * Written in the shipped column spelling rather than a minimal one, because the clearance reads it
 * through the dispatch fence's own parse and a fixture the fence would call `Malformed` would prove
 * nothing about the row it is meant to be testing.
 */
export const campaignsTable = (...rows: ReadonlyArray<CampaignFixtureRow>): string =>
	[
		"# Roadmap",
		"",
		"## Campaigns",
		"",
		"| Campaign | Milestone | State |",
		"|----------|-----------|-------|",
		...rows.map((row) => `| ${row.name} | #${row.milestone} | ${row.state} |`),
		"",
	].join("\n");

/** The lane branch `childLaneBranches` reads for {@link LANE}'s issue. */
export const LANE_BRANCH = `build/${LANE}-caylak-in-place-reads-87b626e1`;

/** `git for-each-ref`'s answer — one branch name per line. */
export const branchList = (...names: ReadonlyArray<string>): ExecResult => okOut(names.join("\n"));

/** `git worktree list --porcelain`'s answer, as blocks of `worktree`/`HEAD`/`branch` lines. */
export const worktreeList = (
	...held: ReadonlyArray<{readonly path: string; readonly branch: string}>
): ExecResult =>
	okOut(
		held
			.map((tree) => `worktree ${tree.path}\nHEAD 0000000\nbranch refs/heads/${tree.branch}\n`)
			.join("\n"),
	);

/**
 * The closing-PR edge `pullsClosing` reads, each node's GraphQL state named.
 *
 * The state is the fixture's to say because it is what the read filters on, and `MERGED` is the one
 * the queue-moved recipe's own success case turns on — a landed PR is closed (#6717).
 */
export const closingPullsIn = (
	...rows: ReadonlyArray<{readonly number: number; readonly state: string}>
): ExecResult =>
	okOut(
		JSON.stringify({
			data: {
				repository: {
					issue: {
						closedByPullRequestsReferences: {
							pageInfo: {hasNextPage: false, endCursor: null},
							nodes: rows.map((row) => ({
								number: row.number,
								url: `https://example.test/pull/${row.number}`,
								state: row.state,
							})),
						},
					},
				},
			},
		}),
	);

/** The same edge with every node open — what every caller but the queue-stall row nominates from. */
export const closingPulls = (...numbers: ReadonlyArray<number>): ExecResult =>
	closingPullsIn(...numbers.map((number) => ({number, state: "OPEN"})));

/** The search index's nomination envelope — candidate numbers, never a proof (`searchOpenPulls`). */
export const nominatedPulls = (...numbers: ReadonlyArray<number>): ExecResult =>
	okOut(JSON.stringify({total_count: numbers.length, items: numbers.map((number) => ({number}))}));

export interface RunShape {
	readonly id: number;
	readonly name?: string;
	readonly status?: string;
	readonly conclusion?: string | null;
	readonly attempt?: number;
}

const runBody = (shape: RunShape): Record<string, unknown> => ({
	id: shape.id,
	name: shape.name ?? "ci",
	status: shape.status ?? "completed",
	conclusion: shape.conclusion === undefined ? "failure" : shape.conclusion,
	run_attempt: shape.attempt ?? 1,
});

/** The Actions list endpoint's page — rows under `workflow_runs`, never a bare array. */
export const runsAtHead = (...shapes: ReadonlyArray<RunShape>): HttpReply => ({
	status: 200,
	body: JSON.stringify({total_count: shapes.length, workflow_runs: shapes.map(runBody)}),
});

/** One run, re-read. */
export const oneRun = (shape: RunShape): HttpReply => ({
	status: 200,
	body: JSON.stringify(runBody(shape)),
});

/** A served refusal — the status is the fact, and the message is what GitHub prints beside it. */
export const httpError = (status: number, message = "refused"): HttpReply => ({
	status,
	body: JSON.stringify({message}),
});

/** A `governance` verdict comment body at `sha`. */
export const governanceMarker = (polarity: "PASS" | "FAIL", sha: string): string =>
	`governance: ${polarity} @ ${sha} — corpus intact`;
