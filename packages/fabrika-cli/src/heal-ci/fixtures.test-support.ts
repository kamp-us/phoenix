/**
 * The canned GitHub payloads the `heal-ci` verb tests script their spawner with, plus the command
 * patterns each read is matched on.
 *
 * The `ship` group's fixtures are reused wherever the payload is the same shape — a second literal
 * for one platform response is how two tests come to disagree about what the platform returns.
 */
import {okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {httpPage} from "../ship/fixtures.test-support.ts";

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
export const COMMIT_DATE =
	/^gh api repos\/o\/r\/commits\/[0-9a-f]+ --jq \.commit\.committer\.date$/;
export const CHECK_RUNS = /^gh api --paginate repos\/o\/r\/commits\/[0-9a-f]+\/check-runs/;
export const WORKFLOWS = /^gh api --paginate repos\/o\/r\/actions\/workflows/;
export const RUN_COUNT = /^gh api repos\/o\/r\/actions\/runs\?head_sha=[0-9a-f]+&per_page=1$/;
export const RUNS_AT_HEAD = /^gh api --paginate repos\/o\/r\/actions\/runs\?head_sha=/;
export const RULES = /^gh api -i repos\/o\/r\/rules\/branches\/main/;
export const PROTECTION = /^gh api repos\/o\/r\/branches\/main\/protection$/;
export const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4321\/comments/;
export const TIMELINE = /^gh api -i repos\/o\/r\/issues\/4321\/timeline/;
export const REVIEWS = /^gh api -i repos\/o\/r\/pulls\/4321\/reviews/;
export const COMPARE = /^gh api repos\/o\/r\/compare\/main\.\.\.[0-9a-f]+ --jq \.behind_by$/;
export const PERMISSION = /^gh api repos\/o\/r\/collaborators\/\S+\/permission/;
export const JOBS = /^gh api --paginate repos\/o\/r\/actions\/runs\/\d+\/jobs/;
export const JOB_LOG = /^gh api repos\/o\/r\/actions\/jobs\/\d+\/logs$/;
export const RUN = /^gh api repos\/o\/r\/actions\/runs\/\d+$/;
export const RERUN = /^gh api --method POST repos\/o\/r\/actions\/runs\/\d+\/rerun-failed-jobs$/;
export const OPEN_PULLS = /^gh api -i repos\/o\/r\/pulls\?state=open/;
export const RATE_LIMIT = /^gh api rate_limit$/;
export const CREATE_COMMENT = /^gh api --method POST repos\/o\/r\/issues\/\d+\/comments/;
export const READ_COMMENT = /^gh api repos\/o\/r\/issues\/comments\/\d+$/;

/** A `--paginate` bare-array page — the shape `pagedJson` walks. */
export const jsonArray = (value: unknown): ExecResult => okOut(JSON.stringify(value));

export const files = (...names: ReadonlyArray<string>): ExecResult =>
	okOut(JSON.stringify(names.map((filename) => ({filename}))));

export const commitDate = (at: string): ExecResult => okOut(at);

export const behind = (by: number): ExecResult => okOut(String(by));

export const permission = (level: string): ExecResult => okOut(level);

/** A `rules/branches/<branch>` page: only `required_status_checks` rules carry contexts. */
export const rules = (...contexts: ReadonlyArray<string>): ExecResult =>
	httpPage(
		JSON.stringify(
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
		),
	);

export const protection = (...contexts: ReadonlyArray<string>): ExecResult =>
	okOut(JSON.stringify({required_status_checks: {contexts}}));

export const jobs = (
	declared: number,
	rows: ReadonlyArray<{id: number; name: string; conclusion?: string | null}>,
): ExecResult =>
	okOut(
		JSON.stringify({
			total_count: declared,
			jobs: rows.map((row) => ({
				id: row.id,
				name: row.name,
				status: "completed",
				conclusion: row.conclusion ?? "failure",
			})),
		}),
	);

export const workflowRun = (shape: {
	id?: number;
	head?: string;
	status?: string;
	conclusion?: string | null;
	attempt?: number;
}): ExecResult =>
	okOut(
		JSON.stringify({
			id: shape.id ?? 9182736450,
			head_sha: shape.head ?? "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c",
			status: shape.status ?? "completed",
			conclusion: shape.conclusion === undefined ? "failure" : shape.conclusion,
			run_attempt: shape.attempt ?? 1,
		}),
	);

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

export const openPulls = (...rows: ReadonlyArray<{number: number; head: string}>): ExecResult =>
	httpPage(JSON.stringify(rows.map((row) => ({number: row.number, head: {sha: row.head}}))));

export const rateLimit = (remaining: number): ExecResult =>
	okOut(JSON.stringify({resources: {core: {remaining, reset: 1_800_000_000}}}));

export const createdComment = (id: number): ExecResult =>
	okOut(JSON.stringify({id, html_url: `https://example.test/pull/4321#issuecomment-${id}`}));

export const commentBody = (body: string): ExecResult => okOut(JSON.stringify({body}));
