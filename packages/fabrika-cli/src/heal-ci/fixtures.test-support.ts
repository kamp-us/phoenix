/**
 * The canned GitHub payloads the `heal-ci` verb tests script their spawner with, plus the command
 * patterns each read is matched on.
 *
 * The `ship` group's fixtures are reused wherever the payload is the same shape — a second literal
 * for one platform response is how two tests come to disagree about what the platform returns.
 */
import type {HttpReply} from "../fakes.test-support.ts";
import {okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";

const API = "https:\\/\\/api\\.github\\.com";

export {
	checkRuns,
	comments,
	ENV,
	HEAD,
	httpPage,
	OTHER_HEAD,
	pull,
	reviews,
	runsTotal,
	timeline,
	unexhaustedPage,
	workflows,
} from "../ship/fixtures.test-support.ts";

export const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
export const FILES = /^gh api --paginate repos\/o\/r\/pulls\/4321\/files/;
export const COMMIT_EXISTS = /^gh api repos\/o\/r\/commits\/[0-9a-f]+ --jq \.sha$/;
export const CHECK_RUNS = /^gh api --paginate repos\/o\/r\/commits\/[0-9a-f]+\/check-runs/;
export const WORKFLOWS = /^gh api --paginate repos\/o\/r\/actions\/workflows/;
export const RUN_COUNT = /^gh api repos\/o\/r\/actions\/runs\?head_sha=[0-9a-f]+&per_page=1$/;
export const RUNS_AT_HEAD = /^gh api --paginate repos\/o\/r\/actions\/runs\?head_sha=/;
export const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4321\/comments/;
export const TIMELINE = /^gh api -i repos\/o\/r\/issues\/4321\/timeline/;
export const REVIEWS = /^gh api -i repos\/o\/r\/pulls\/4321\/reviews/;
export const COMPARE = /^gh api repos\/o\/r\/compare\/main\.\.\.[0-9a-f]+ --jq \.behind_by$/;
export const PERMISSION = /^gh api repos\/o\/r\/collaborators\/\S+\/permission/;
/**
 * The nine reads this group makes over the HTTP client, matched on `METHOD url` (ADR 0315).
 *
 * `RUN` ends on the run id so it cannot also match `runs/<id>/jobs` — two patterns that overlap are
 * a script whose second entry is unreachable, and the answer would come from whichever is listed
 * first rather than from the endpoint the test meant.
 */
export const JOBS = new RegExp(`^GET ${API}\\/repos\\/o\\/r\\/actions\\/runs\\/\\d+\\/jobs\\?`);
export const JOB_LOG = new RegExp(`^GET ${API}\\/repos\\/o\\/r\\/actions\\/jobs\\/\\d+\\/logs$`);
export const RUN = new RegExp(`^GET ${API}\\/repos\\/o\\/r\\/actions\\/runs\\/\\d+$`);
export const RERUN = new RegExp(
	`^POST ${API}\\/repos\\/o\\/r\\/actions\\/runs\\/\\d+\\/rerun-failed-jobs$`,
);
export const OPEN_PULLS = new RegExp(`^GET ${API}\\/repos\\/o\\/r\\/pulls\\?state=open`);
export const RATE_LIMIT = new RegExp(`^GET ${API}\\/rate_limit$`);
export const RULES = new RegExp(`^GET ${API}\\/repos\\/o\\/r\\/rules\\/branches\\/main\\?`);
export const PROTECTION = new RegExp(`^GET ${API}\\/repos\\/o\\/r\\/branches\\/main\\/protection$`);
export const COMMIT_DATE = new RegExp(`^GET ${API}\\/repos\\/o\\/r\\/commits\\/[0-9a-f]+$`);
export const CREATE_COMMENT = /^gh api --method POST repos\/o\/r\/issues\/\d+\/comments/;
export const READ_COMMENT = /^gh api repos\/o\/r\/issues\/comments\/\d+$/;

/** A `--paginate` bare-array page — the shape `pagedJson` walks. */
export const jsonArray = (value: unknown): ExecResult => okOut(JSON.stringify(value));

export const files = (...names: ReadonlyArray<string>): ExecResult =>
	okOut(JSON.stringify(names.map((filename) => ({filename}))));

export const behind = (by: number): ExecResult => okOut(String(by));

export const permission = (level: string): ExecResult => okOut(level);

/** A terminal page: 200 with no `rel="next"`, which is what the exhaustion proof reads. */
const served = (body: unknown, status = 200): HttpReply => ({
	status,
	body: JSON.stringify(body),
});

/** A `rules/branches/<branch>` page: only `required_status_checks` rules carry contexts. */
export const rules = (...contexts: ReadonlyArray<string>): HttpReply =>
	served(
		contexts.length === 0
			? []
			: [
					{
						type: "required_status_checks",
						parameters: {
							required_status_checks: contexts.map((context) => ({context})),
						},
					},
				],
	);

export const protection = (...contexts: ReadonlyArray<string>): HttpReply =>
	served({required_status_checks: {contexts}});

export const jobs = (
	declared: number,
	rows: ReadonlyArray<{id: number; name: string; conclusion?: string | null}>,
): HttpReply =>
	served({
		total_count: declared,
		jobs: rows.map((row) => ({
			id: row.id,
			name: row.name,
			status: "completed",
			conclusion: row.conclusion ?? "failure",
		})),
	});

export const workflowRun = (shape: {
	id?: number;
	head?: string;
	status?: string;
	conclusion?: string | null;
	attempt?: number;
}): HttpReply =>
	served({
		id: shape.id ?? 9182736450,
		head_sha: shape.head ?? "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c",
		status: shape.status ?? "completed",
		conclusion: shape.conclusion === undefined ? "failure" : shape.conclusion,
		run_attempt: shape.attempt ?? 1,
	});

/** The commit payload `commitPushedAt` reads its date out of. */
export const commitDate = (at: string): HttpReply => served({commit: {committer: {date: at}}});

/** GitHub's own answer to a rerun POST: 201, no body. */
export const accepted: HttpReply = {status: 201, body: ""};

/** A served refusal — the status is the fact, and the message is what GitHub prints beside it. */
export const httpError = (status: number, message = "refused"): HttpReply => ({
	status,
	body: JSON.stringify({message}),
});

export const runsAtHead = (
	declared: number,
	rows: ReadonlyArray<{
		id: number;
		name?: string;
		status?: string;
		conclusion?: string | null;
	}>,
): ExecResult =>
	okOut(
		JSON.stringify({
			total_count: declared,
			workflow_runs: rows.map((row) => ({
				id: row.id,
				name: row.name ?? "ci",
				status: row.status ?? "completed",
				conclusion: row.conclusion === undefined ? "failure" : row.conclusion,
				completed_at: "2026-08-08T00:00:00Z",
			})),
		}),
	);

export const openPulls = (...rows: ReadonlyArray<{number: number; head: string}>): HttpReply =>
	served(rows.map((row) => ({number: row.number, head: {sha: row.head}})));

export const rateLimit = (remaining: number): HttpReply =>
	served({resources: {core: {remaining, reset: 1_800_000_000}}});

export const createdComment = (id: number): ExecResult =>
	okOut(JSON.stringify({id, html_url: `https://example.test/pull/4321#issuecomment-${id}`}));

export const commentBody = (body: string): ExecResult => okOut(JSON.stringify({body}));
