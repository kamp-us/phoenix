/**
 * The canned payloads the `recipe` verb tests script their spawner and their filesystem with.
 *
 * The PR shape itself is `ship/fixtures.test-support.ts`'s — the §CP clearance is that group's verb
 * relayed, so a second PR fixture here would let the two disagree about what the platform returns.
 */
import {okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {coderTemplateText} from "../lane/fixtures.test-support.ts";

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

/** queued → blocked, the bare park no fixed fix keys on. */
export const PARKED_BLOCKED = eventLog("BLOCKED");

/** The closing-PR edge `openPullsClosing` reads — one open PR declaring it closes the issue. */
export const closingPulls = (...numbers: ReadonlyArray<number>): ExecResult =>
	okOut(
		JSON.stringify({
			data: {
				repository: {
					issue: {
						closedByPullRequestsReferences: {
							pageInfo: {hasNextPage: false, endCursor: null},
							nodes: numbers.map((number) => ({
								number,
								url: `https://example.test/pull/${number}`,
								state: "OPEN",
							})),
						},
					},
				},
			},
		}),
	);

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
export const runsAtHead = (...shapes: ReadonlyArray<RunShape>): ExecResult =>
	okOut(JSON.stringify({total_count: shapes.length, workflow_runs: shapes.map(runBody)}));

/** One run, re-read. */
export const oneRun = (shape: RunShape): ExecResult => okOut(JSON.stringify(runBody(shape)));

/** A `governance` verdict comment body at `sha`. */
export const governanceMarker = (polarity: "PASS" | "FAIL", sha: string): string =>
	`governance: ${polarity} @ ${sha} — corpus intact`;
