/**
 * The canned GitHub payloads the `ship` verb tests script their spawner with.
 *
 * One module, because every verb in the group reads the same PR shape — a per-test literal is how
 * two tests come to disagree about what the platform returns.
 */
import type {HttpReply} from "../fakes.test-support.ts";
import {okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";

export const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
export const OTHER_HEAD = "9fe12ab04f5a6b7c8d9e0f1a2b3c4d5e6f708192";

export interface PullShape {
	readonly state?: string;
	readonly head?: string;
	readonly body?: string;
	readonly changedFiles?: number;
	readonly comments?: number;
	readonly draft?: boolean;
	readonly merged?: boolean;
	readonly base?: string;
	readonly autoMerge?: boolean;
	readonly author?: string;
	/** `null` is the platform's lazy "not computed yet" — an indefinite read, never an answer. */
	readonly mergeable?: boolean | null;
	readonly mergeableState?: string;
	/** Who has taken the PR — `heal-ci diagnose`'s owner signal. */
	readonly assignees?: ReadonlyArray<string>;
	readonly updatedAt?: string;
}

export const pull = (shape: PullShape = {}): ExecResult =>
	okOut(
		JSON.stringify({
			number: 4321,
			state: shape.state ?? "open",
			head: {sha: shape.head ?? HEAD},
			base: {ref: shape.base ?? "main"},
			body: shape.body ?? "does a thing\n\nFixes #4287\n",
			changed_files: shape.changedFiles ?? 2,
			comments: shape.comments ?? 0,
			draft: shape.draft ?? false,
			merged: shape.merged ?? false,
			auto_merge: shape.autoMerge === true ? {enabled_by: {login: "usirin"}} : null,
			user: {login: shape.author ?? "usirin"},
			mergeable: shape.mergeable === undefined ? true : shape.mergeable,
			mergeable_state: shape.mergeableState ?? "blocked",
			assignees: (shape.assignees ?? []).map((login) => ({login})),
			updated_at: shape.updatedAt ?? "2026-08-08T00:00:00Z",
		}),
	);

export const files = (...names: ReadonlyArray<string>): ExecResult =>
	okOut(JSON.stringify(names.map((filename) => ({filename}))));

export const CODEOWNERS = `# a boundary
/.github/    @kamp-us/control-plane
/packages/demo-cli/src/*  @kamp-us/control-plane
/packages/demo-cli/src/tools/
`;

export const checkRuns = (
	declared: number,
	runs: ReadonlyArray<{
		name: string;
		status: string;
		conclusion?: string | null;
		started_at?: string | null;
		id?: number;
		/** The suite that published it — what {@link runsTotal}'s rows are joined to. */
		check_suite_id?: number;
	}>,
): ExecResult =>
	okOut(
		JSON.stringify({
			total_count: declared,
			check_runs: runs.map((run, index) => ({
				id: run.id ?? index + 1,
				name: run.name,
				status: run.status,
				conclusion: run.conclusion ?? null,
				started_at: run.started_at ?? "2026-08-08T00:00:00Z",
				check_suite: {id: run.check_suite_id ?? 1},
			})),
		}),
	);

/**
 * The workflow inventory: one entry per argument, each a state or a `{state, path}` pair.
 *
 * The default path is deliberately outside `.github/workflows/`, so a caller that says only "active"
 * declares no *gate* — `../review/gate-coverage.ts` reads the prefix, and a fixture that quietly
 * declared one would make every case a coverage case.
 */
export const workflows = (
	...entries: ReadonlyArray<string | {state?: string; path: string}>
): ExecResult =>
	okOut(
		JSON.stringify({
			total_count: entries.length,
			workflows: entries.map((entry, index) => ({
				id: index + 1,
				state: typeof entry === "string" ? entry : (entry.state ?? "active"),
				path: typeof entry === "string" ? `.github/w${index}.yml` : entry.path,
			})),
		}),
	);

/**
 * The Actions run list at one head: the declared total, and the rows a caller cares to enumerate.
 *
 * The total and the rows are separate arguments because they answer separate questions — the
 * `no-runs` discriminator reads only the first, supersession only the second.
 */
export const runsTotal = (
	total: number,
	rows: ReadonlyArray<{
		id: number;
		workflowId?: number;
		checkSuiteId?: number | null;
		status?: string;
		conclusion?: string | null;
		/** Which workflow produced the run — the gate-coverage read's only input. */
		path?: string;
	}> = [],
): ExecResult =>
	okOut(
		JSON.stringify({
			total_count: total,
			workflow_runs: rows.map((row) => ({
				id: row.id,
				name: "ci",
				path: row.path ?? ".github/workflows/ci.yml",
				workflow_id: row.workflowId ?? 1,
				check_suite_id: row.checkSuiteId === undefined ? row.id : row.checkSuiteId,
				status: row.status ?? "completed",
				conclusion: row.conclusion === undefined ? "success" : row.conclusion,
				completed_at: "2026-08-08T00:00:00Z",
			})),
		}),
	);

export const comments = (
	...rows: ReadonlyArray<{id: number; body: string; author?: string; updatedAt?: string}>
): ExecResult =>
	okOut(
		JSON.stringify(
			rows.map((row) => ({
				id: row.id,
				user: {login: row.author ?? "reviewer"},
				created_at: "2026-08-08T00:00:00Z",
				updated_at: row.updatedAt ?? "2026-08-08T00:00:00Z",
				body: row.body,
			})),
		),
	);

export const threadPage = (
	declared: number,
	nodes: ReadonlyArray<{
		id: string;
		isResolved?: boolean;
		path?: string | null;
		line?: number | null;
		comments: ReadonlyArray<{body: string; login: string; typename: string}>;
		declaredComments?: number;
	}>,
): ExecResult =>
	okOut(
		JSON.stringify({
			data: {
				repository: {
					pullRequest: {
						reviewThreads: {
							totalCount: declared,
							pageInfo: {hasNextPage: false, endCursor: null},
							nodes: nodes.map((node) => ({
								id: node.id,
								isResolved: node.isResolved ?? false,
								path: node.path ?? null,
								line: node.line ?? null,
								comments: {
									totalCount: node.declaredComments ?? node.comments.length,
									nodes: node.comments.map((comment) => ({
										body: comment.body,
										author: {login: comment.login, __typename: comment.typename},
									})),
								},
							})),
						},
					},
				},
			},
		}),
	);

export const issue = (labels: ReadonlyArray<string> = []): ExecResult =>
	okOut(
		JSON.stringify({
			number: 4287,
			title: "t",
			body: "b",
			state: "open",
			labels: labels.map((name) => ({name})),
			html_url: "https://example.test/issues/4287",
			milestone: null,
		}),
	);

/** The branch's active rules. `[]` is the answer for a branch nothing governs, not a failure. */
export const branchRules = (...types: ReadonlyArray<string>): ExecResult =>
	okOut(JSON.stringify(types.map((type) => ({type}))));

/** The repository's permitted merge methods. An omitted flag reads `false`. */
export const repository = (
	allowed: {squash?: boolean; merge?: boolean; rebase?: boolean} = {},
): ExecResult =>
	okOut(
		JSON.stringify({
			full_name: "o/r",
			allow_squash_merge: allowed.squash ?? true,
			allow_merge_commit: allowed.merge ?? true,
			allow_rebase_merge: allowed.rebase ?? true,
		}),
	);

/** The repository payload as the HTTP client reads it — the same flags, off a served body. */
export const repositoryServed = (
	allowed: {squash?: boolean; merge?: boolean; rebase?: boolean} = {},
): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		full_name: "o/r",
		allow_squash_merge: allowed.squash ?? true,
		allow_merge_commit: allowed.merge ?? true,
		allow_rebase_merge: allowed.rebase ?? true,
	}),
});

/**
 * The landing read-back, off the pull request's own payload.
 *
 * `merge_commit_sha` is the payload's key, not the `--jq` era's projected `commit`: the projection
 * is gone with `gh`, so the fixture speaks the endpoint's own shape.
 */
export const mergeProofServed = (shape: {merged?: boolean; commit?: string} = {}): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		merged: shape.merged ?? true,
		merge_commit_sha: shape.commit ?? MERGE_COMMIT,
	}),
});

export const MERGE_COMMIT = "5c7d1e930a2b4f6d8e0c1a3b5d7f9e1c3a5b7d9f";

/**
 * The environment every ship verb test hands its verb.
 *
 * `GITHUB_TOKEN` is here because the GitHub client takes a credential as an argument (ADR 0315) and
 * resolves it from this environment — without it a test would fall through to a `gh auth token`
 * spawn and read the developer's own login, which is exactly the inherited state the scripted seams
 * exist to remove.
 */
export const ENV = {CLAUDE_PIPELINE_REPO: "o/r", GITHUB_TOKEN: "ghp_scripted"} as Record<
	string,
	string | undefined
>;
