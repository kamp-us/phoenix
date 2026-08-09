/**
 * The canned `gh` and `git` responses the `ledger` verb tests script their spawner with.
 *
 * Shaped like the real payloads rather than like the parsers, so a parser that starts reading a
 * different field still has to find it here — a fixture trimmed to exactly what the code reads today
 * stops being able to catch tomorrow's misread. The sub-issue payload carries `id` alongside `number`
 * for the same reason the link and unlink take it: it is the field the relation is keyed on.
 */

import {comments, LANE_UUID, marker, NONCE} from "../build/fixtures.test-support.ts";
import {okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {PLAN_SECTIONS} from "./plan-block.ts";
import {runDir, runKey} from "./run.ts";

export const EPIC = 4300;
export const SESSION = "s-9f2e";
export const REPO = "o/r";
/** The tree root `LINKED` names — every run path in these tests hangs off it. */
export const WORKTREE = "/repo/trees/lane-a";
export const GIT_DIR = "/repo/.git/worktrees/lane-a";
export const DIR = runDir(WORKTREE, runKey(EPIC, NONCE));
export const EXCLUDE_PATH = `${GIT_DIR}/info/exclude`;

export const env = {CLAUDE_PIPELINE_REPO: REPO, CLAUDE_CODE_SESSION_ID: SESSION} as Record<
	string,
	string | undefined
>;

export const epic = (overrides: Record<string, unknown> = {}): ExecResult =>
	okOut(
		JSON.stringify({
			number: EPIC,
			title: "The moderation queue epic",
			body: "An epic brief about the moderation queue.\n",
			state: "open",
			labels: [{name: "type:epic"}, {name: "status:triaged"}],
			html_url: "https://github.com/o/r/issues/4300",
			milestone: null,
			state_reason: null,
			...overrides,
		}),
	);

export interface SubIssueFixture {
	readonly number: number;
	readonly id?: number;
	readonly title?: string;
	readonly labels?: ReadonlyArray<string>;
}

export const subIssues = (...rows: ReadonlyArray<SubIssueFixture>): ExecResult =>
	okOut(
		JSON.stringify(
			rows.map((row) => ({
				number: row.number,
				id: row.id ?? row.number * 1000,
				title: row.title ?? `child ${row.number}`,
				labels: (row.labels ?? ["type:feature", "p1"]).map((name) => ({name})),
			})),
		),
	);

export const childIssue = (options: {
	number: number;
	labels?: ReadonlyArray<string>;
	assignees?: ReadonlyArray<string>;
	milestone?: string | null;
	state?: string;
	stateReason?: string | null;
	body?: string;
}): ExecResult =>
	okOut(
		JSON.stringify({
			number: options.number,
			title: `child ${options.number}`,
			body: options.body ?? "a child body\n",
			state: options.state ?? "open",
			state_reason: options.stateReason ?? null,
			labels: (options.labels ?? []).map((name) => ({name})),
			assignees: (options.assignees ?? []).map((login) => ({login})),
			milestone: options.milestone == null ? null : {number: 44, title: options.milestone},
			html_url: `https://github.com/o/r/issues/${options.number}`,
		}),
	);

/** A plan block that clears the section set and the story grammar. */
export const planBlock = (overrides: {stories?: string; drop?: string} = {}): string =>
	[
		"## Plan (plan-epic)",
		"",
		...PLAN_SECTIONS.filter((heading) => heading !== overrides.drop).flatMap((heading) => [
			`### ${heading}`,
			"",
			heading === "User stories"
				? (overrides.stories ??
					"1. As a moderator, I want a queue.\n2. As a yazar, I want a receipt.")
				: "Something true about this section.",
			"",
		]),
	].join("\n");

/** A child body that clears the field and criteria readers. */
export const childBody = (
	overrides: {stories?: string; containment?: string | null; criteria?: string} = {},
): string =>
	[
		`**Stories:** ${overrides.stories ?? "1, 2"}`,
		"**TDD:** yes",
		...(overrides.containment === null
			? []
			: [`**Containment:** ${overrides.containment ?? "flag (default-off)"}`]),
		"",
		"### What to build",
		"",
		"The queue view, over the fate loader.",
		"",
		"### Acceptance criteria",
		overrides.criteria ?? "- [ ] the queue view renders the ten most recent reports",
		"",
	].join("\n");

export const labelSet = (...names: ReadonlyArray<string>): ExecResult =>
	okOut(`${names.join("\n")}\n`);

export const DEFAULT_LABELS: ReadonlyArray<string> = [
	"type:feature",
	"type:bug",
	"type:chore",
	"p0",
	"p1",
	"p2",
	"status:planned",
	"ready-for:agent",
	"ready-for:human",
];

export const milestones = (...rows: ReadonlyArray<readonly [number, string]>): ExecResult =>
	okOut(rows.map(([number, title]) => `${number}\t${title}`).join("\n"));

/** `<number>\t<title>` rows, the shape both dedup sources are read in. */
export const issueRows = (...rows: ReadonlyArray<readonly [number, string]>): ExecResult =>
	okOut(rows.map(([number, title]) => `${number}\t${title}`).join("\n"));

/** The claim on the epic, held by this session under the lane the run key is derived from. */
export const CLAIMED: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[
		new RegExp(`^gh api --paginate repos/${REPO}/issues/${EPIC}/comments`),
		comments({id: 1, body: marker(SESSION, LANE_UUID)}),
	],
	[new RegExp(`^gh api repos/${REPO}/collaborators/agent/permission`), okOut("write\n")],
];

export {NONCE};
