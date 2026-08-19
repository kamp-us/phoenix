/**
 * The canned GitHub payloads the `ship` verb tests script their spawner with.
 *
 * One module, because every verb in the group reads the same PR shape — a per-test literal is how
 * two tests come to disagree about what the platform returns.
 */
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
/packages/pipeline-cli/src/*  @kamp-us/control-plane
/packages/pipeline-cli/src/tools/
`;

export const checkRuns = (
	declared: number,
	runs: ReadonlyArray<{
		name: string;
		status: string;
		conclusion?: string | null;
		started_at?: string | null;
		id?: number;
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
			})),
		}),
	);

export const workflows = (...states: ReadonlyArray<string>): ExecResult =>
	okOut(
		JSON.stringify({
			total_count: states.length,
			workflows: states.map((state, index) => ({
				id: index + 1,
				state,
				path: `.github/w${index}.yml`,
			})),
		}),
	);

export const runsTotal = (total: number): ExecResult => okOut(JSON.stringify({total_count: total}));

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

/**
 * A `gh api -i` response: status line, headers, blank line, body.
 *
 * The bare-array reads prove completeness by **exhausted pagination**, so their fixtures have to
 * carry the header that proof reads. Omitting the `Link` header is a terminal page (the platform
 * sends none when there is only one); `next` present is a page still outstanding.
 */
export const httpPage = (body: string, options: {next?: boolean} = {}): ExecResult =>
	okOut(
		[
			"HTTP/2.0 200 OK",
			"content-type: application/json",
			...(options.next === true
				? ['link: <https://api.github.com/next?page=2>; rel="next", <https://x>; rel="last"']
				: []),
			"",
			body,
		].join("\r\n"),
	);

export const reviews = (
	...rows: ReadonlyArray<{login: string; state: string; commit: string; at?: string}>
): ExecResult =>
	httpPage(
		JSON.stringify(
			rows.map((row) => ({
				user: {login: row.login},
				state: row.state,
				commit_id: row.commit,
				submitted_at: row.at ?? "2026-08-08T00:00:00Z",
			})),
		),
	);

export const timeline = (...rows: ReadonlyArray<{event: string; at: string}>): ExecResult =>
	httpPage(JSON.stringify(rows.map((row) => ({event: row.event, created_at: row.at}))));

/** The same page, but declaring a `next` — the read that can never prove it is complete. */
export const unexhaustedPage = (): ExecResult => httpPage("[]", {next: true});

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

/** The landing read-back projection: `merged` beside the commit that proves it. */
export const mergeProof = (shape: {merged?: boolean; commit?: string} = {}): ExecResult =>
	okOut(JSON.stringify({merged: shape.merged ?? true, commit: shape.commit ?? MERGE_COMMIT}));

export const MERGE_COMMIT = "5c7d1e930a2b4f6d8e0c1a3b5d7f9e1c3a5b7d9f";

export const ENV = {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>;
