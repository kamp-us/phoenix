/**
 * The canned `gh` and `git` responses the `build` verb tests script their spawner with.
 *
 * They are shaped like the real payloads rather than like the parsers, so a parser that starts reading
 * a different field still has to find it here — a fixture trimmed to exactly what the code reads today
 * stops being able to catch tomorrow's misread.
 */
import {type HttpReply, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";

/**
 * The credential a ported test hands its verb.
 *
 * `resolveToken` reads the env before it reaches for `gh auth token`, so naming one here keeps a
 * test about some other axis from having to script a spawn it does not care about (ADR 0315).
 */
export const GH_TOKEN_ENV = {GITHUB_TOKEN: "ghp_scripted"} as const;

/** One served JSON answer, for a test scripting the HTTP seam. */
export const served = (payload: unknown, status = 200): HttpReply => ({
	status,
	body: JSON.stringify(payload),
});

/** What the API answers for a number that does not exist — the `Absent` arm's whole evidence. */
export const NOT_FOUND: HttpReply = {status: 404, body: '{"message":"Not Found"}'};

/** Served, and unreadable for a reason that is not absence — the `Unknown` arm. */
export const GATEWAY: HttpReply = {status: 502, body: '{"message":"Bad gateway"}'};

export const HEAD = "03135b9188d2be6c0a4b7bd0b7a3ff9c53f0f2b1";
export const OLD_HEAD = "8f1c2ad4e5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0";

/**
 * Heads a repair loop pushed before the live one, newest last.
 *
 * A round is one graded head (`./rounds.ts`), so a test that wants N rounds needs N distinct heads;
 * repeating one head is one round however the timestamps are spread.
 */
export const PRIOR_HEADS = [
	"1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
	"2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e",
	"3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f",
	"4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70",
] as const;

/** What `git rev-parse` names for a checkout: its git dir, then its tree root. */
export const GIT_DIRS = okOut(["/repo/trees/lane-a/.git", "/repo/trees/lane-a"].join("\n"));

export const issuePayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	number: 4312,
	title: "Editor loses focus after save",
	body: CRITERIA_BODY,
	state: "open",
	labels: [{name: "type:bug"}, {name: "p1"}, {name: "status:triaged"}],
	html_url: "https://github.com/o/r/issues/4312",
	milestone: null,
	state_reason: null,
	...overrides,
});

export const issue = (overrides: Record<string, unknown> = {}): ExecResult =>
	okOut(JSON.stringify(issuePayload(overrides)));

export const pullPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	number: 4318,
	state: "open",
	head: {sha: HEAD, ref: "build/4312-editor-focus-loss-c1a4d6f8"},
	body: "Fixes #4312\n\n## Deviations\nNone.\n",
	changed_files: 3,
	comments: 0,
	merged: false,
	...overrides,
});

export const pull = (overrides: Record<string, unknown> = {}): ExecResult =>
	okOut(JSON.stringify(pullPayload(overrides)));

/** One paged `issues/<n>/comments` response. */
export const comments = (
	...rows: ReadonlyArray<{id: number; body: string; author?: string; createdAt?: string}>
): ExecResult =>
	okOut(
		JSON.stringify(
			rows.map((row) => ({
				id: row.id,
				body: row.body,
				user: {login: row.author ?? "agent"},
				created_at: row.createdAt ?? "2026-08-09T00:00:00Z",
			})),
		),
	);

/**
 * The same response, cut off before its last comment closes — what a killed `gh --paginate` leaves
 * on stdout, and the read a claim must never resolve ownership from.
 */
export const truncatedComments = (
	...rows: ReadonlyArray<{id: number; body: string; author?: string; createdAt?: string}>
): ExecResult => {
	const whole = comments(...rows).stdout;
	return okOut(whole.slice(0, whole.lastIndexOf("}")));
};

/**
 * Every `blocked_by` edge list answering empty — the unblocked board, for a test about some other
 * axis.
 *
 * {@link fakeShell} resolves by first match, so this belongs LAST in a script: a test that scripts a
 * specific issue's edges wins over it. Without it every claim and every pool candidate reads an
 * unscripted command, and the blockedness gate correctly seats that as UNKNOWN.
 */
export const NO_BLOCKERS: readonly [RegExp, ExecResult] = [
	/^gh api --paginate repos\/[^ ]+\/issues\/\d+\/dependencies\/blocked_by/,
	okOut("[]"),
];

/** The same edge list, naming one blocker — pair it with that blocker's own `issues/<n>` read. */
export const blockedBy = (...blockers: ReadonlyArray<number>): ExecResult =>
	okOut(JSON.stringify(blockers.map((number) => ({number, state: "open"}))));

/**
 * A body carrying the conforming block — what a triaged, agent-ready issue looks like.
 *
 * Both {@link issue} and {@link candidates} default to it, because the admission test's criteria axis
 * reads the body at the pool AND at the claim seam (#6554): a fixture omitting the block is refused,
 * so every caller not testing that axis would otherwise have to restate it.
 */
export const CRITERIA_BODY =
	"## Summary\n\ns\n\n### Acceptance criteria\n\n- [ ] the one criterion\n";

export interface CandidateFixture {
	readonly number: number;
	readonly title?: string;
	readonly labels: ReadonlyArray<string>;
	readonly assignees?: ReadonlyArray<string>;
	readonly milestone?: number | null;
	readonly pull?: boolean;
	readonly body?: string;
}

/**
 * One paged `issues?labels=…` response, as the candidate pool reads it.
 *
 * `body` defaults to {@link CRITERIA_BODY} because the pool's criteria axis reads it: a row that
 * omitted it would be excluded, so every caller not testing that axis would have to restate the
 * block. Pass `body: ""` for an issue with no contract.
 */
export const candidates = (
	...rows: ReadonlyArray<CandidateFixture>
): ReadonlyArray<Record<string, unknown>> =>
	rows.map((row) => ({
		number: row.number,
		title: row.title ?? `issue ${row.number}`,
		body: row.body ?? CRITERIA_BODY,
		labels: row.labels.map((name) => ({name})),
		assignees: (row.assignees ?? []).map((login) => ({login})),
		milestone:
			row.milestone === undefined || row.milestone === null ? null : {number: row.milestone},
		...(row.pull === true ? {pull_request: {url: "…"}} : {}),
	}));

/** The same rows as one served page — what a test scripts the pool's read with. */
export const candidatePage = (...rows: ReadonlyArray<CandidateFixture>): HttpReply =>
	served(candidates(...rows));

/** A `ROADMAP.md` whose `## Campaigns` table marks these milestones `active` — the fence, on. */
export const campaignsTable = (milestones: number | ReadonlyArray<number>): string => {
	const rows = (typeof milestones === "number" ? [milestones] : milestones)
		.map((milestone) => `| Campaign ${milestone} | #${milestone} | active |`)
		.join("\n");
	return `# Roadmap\n\n## Campaigns\n\n| Campaign | Milestone | State |\n|----------|-----------|-------|\n${rows}\n\n## Arcs\n`;
};

/** The claim marker body a session posts. */
export const marker = (session: string, uuid: string): string =>
	`build-claim: build:${session}:${uuid} · 2026-08-09T00:00:00Z`;

/** The succession marker a successor session posts over a dead one's claim (ADR 0295). */
export const adoptMarker = (
	adopted: string,
	session: string,
	uuid: string,
	reason = "the driver session died mid-flight",
): string =>
	`build-adopt: ${adopted} by build:${session}:${uuid} · 2026-08-09T00:00:00Z · reason: ${reason}`;

export const LANE_UUID = "c1a4d6f8-3b7e-4a19-9c2d-5e8f0a1b2c3d";
/** The lane nonce `LANE_UUID` confers. */
export const NONCE = "c1a4d6f8";
/** The token the fixture lane holds — what it passes as `--token`. */
export const LANE_TOKEN = `build:s-9f2e:${LANE_UUID}`;

/** A second lane of the SAME session `s-9f2e` — the two-lanes-one-session shape (#6037). */
export const SIBLING_UUID = "7bab0955-616f-4a6a-af6e-71c34b7c68c7";
export const SIBLING_NONCE = "7bab0955";
export const SIBLING_TOKEN = `build:s-9f2e:${SIBLING_UUID}`;
