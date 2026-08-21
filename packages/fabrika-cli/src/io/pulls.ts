/**
 * The pull-request surface the `review` verbs read and write: one PR's metadata, its changed-file
 * list, its diff bytes, the check runs at a commit, the invoking token's identity and repository
 * permission, and the comment edit an upsert needs.
 *
 * The `issues.ts` disciplines hold here — every list read paged, absent split from unreadable
 * through {@link Existence}, and a shape that is not what was asked for treated as a failure rather
 * than an empty result. REST is the default surface; {@link openPullsClosing} is on GraphQL because
 * the closing-issue link edge it needs is published nowhere else.
 *
 * **Every list read returns what it received alongside what the platform declared.** A review whose
 * scope was silently truncated is a review over unknown scope, and the only way a caller can refuse
 * that is to be handed both numbers. The reads below never narrow to the received list alone.
 */
import {Effect} from "effect";
import {
	type Api,
	authed,
	authedExistence,
	existenceOf,
	graphqlRead,
	PAGE_CAP,
	pagedEnvelope,
	pagedWithLinkProof,
	type Rest,
	refusalText,
	restCall,
} from "./gh-api.ts";
import {type Attempt, fail, ok, type Shell} from "./git.ts";
import type {Existence} from "./issues.ts";
import {isRecord} from "./json.ts";

export interface PullRecord {
	readonly number: number;
	readonly state: string;
	readonly headSha: string;
	readonly body: string;
	/** The PR's own page — the link a `lane brief` hands a shell, empty when the board published none. */
	readonly htmlUrl: string;
	/** What the platform says the PR changes — the denominator every completeness proof divides by. */
	readonly changedFiles: number;
	/** Issue comments on the PR, as the platform counts them. The verdict sweep's denominator. */
	readonly comments: number;
	/** A draft PR is open but ungateable — `ship scope` reports it, the write verbs refuse it. */
	readonly draft: boolean;
	/** Merged is not derivable from `state`: a merged PR reads `closed` (`ship reconcile`'s `landed`). */
	readonly merged: boolean;
	/** The base branch — whose queue regime, never this PR's history, decides `ship disarm`'s policy. */
	readonly baseRef: string;
	/** Whether a merge intent is currently parked on the PR (ADR 0198's armed state). */
	readonly autoMerge: boolean;
	/** The PR's author — the §CP cardinality table's `sole owner authored the PR` arm. */
	readonly authorLogin: string;
	/** Who has taken the PR, if anyone — `heal-ci diagnose`'s owner signal, and never its ACL. */
	readonly assignees: ReadonlyArray<string>;
	/** The platform's own last-activity stamp — one operand of the strand age. */
	readonly updatedAt: string;
}

const toPullRecord = (value: unknown): PullRecord | null => {
	if (!isRecord(value)) return null;
	const {number, state, head, base, body, changed_files: changedFiles, comments, user} = value;
	const headSha = isRecord(head) && typeof head.sha === "string" ? head.sha : null;
	if (typeof number !== "number" || typeof state !== "string" || headSha === null) return null;
	if (typeof changedFiles !== "number") return null;
	return {
		number,
		state,
		headSha,
		body: typeof body === "string" ? body : "",
		htmlUrl: typeof value.html_url === "string" ? value.html_url : "",
		changedFiles,
		comments: typeof comments === "number" ? comments : 0,
		draft: value.draft === true,
		merged: value.merged === true,
		baseRef: isRecord(base) && typeof base.ref === "string" ? base.ref : "",
		autoMerge: isRecord(value.auto_merge),
		authorLogin: isRecord(user) && typeof user.login === "string" ? user.login : "",
		assignees: Array.isArray(value.assignees)
			? value.assignees.flatMap((entry) =>
					isRecord(entry) && typeof entry.login === "string" ? [entry.login] : [],
				)
			: [],
		updatedAt: typeof value.updated_at === "string" ? value.updated_at : "",
	};
};

/** One pull request, probed three ways — the 404 that seats a proven refusal is split from a 5xx. */
export const getPullRequest = (repo: string, pr: number): Shell<Existence<PullRecord>> =>
	authedExistence((token) =>
		restCall(token, {method: "GET", path: `repos/${repo}/pulls/${pr}`}).pipe(
			Effect.map((outcome) =>
				existenceOf(outcome, (body) => {
					const record = toPullRecord(body);
					return record === null
						? fail("GitHub answered 200 but its output is not a pull request")
						: ok(record);
				}),
			),
		),
	);

/**
 * Every changed path on the PR, paged.
 *
 * Read as typed JSON rather than through a `--jq .filename` projection: the count of entries is the
 * completeness proof, and a filter that errored mid-stream on one odd entry would shorten the list
 * silently — which is the truncation the caller is trying to detect.
 */
export const listPullFiles = (repo: string, pr: number): Shell<Attempt<ReadonlyArray<string>>> =>
	authed((token) =>
		Effect.gen(function* () {
			const page = yield* pagedWithLinkProof(token, `repos/${repo}/pulls/${pr}/files`);
			if (page._tag === "Failure") return page;
			if (!page.value.exhausted) return fail(`PR #${pr}'s file list was not read to its end`);
			const files: string[] = [];
			for (const value of page.value.entries) {
				if (!isRecord(value) || typeof value.filename !== "string") {
					return fail("GitHub answered 200 but one entry is not a changed file");
				}
				files.push(value.filename);
			}
			return ok(files);
		}),
	);

/** The unified diff bytes, served by the platform's diff media type. */
export const getPullDiff = (repo: string, pr: number): Shell<Attempt<string>> =>
	authed((token) =>
		restCall(token, {
			method: "GET",
			path: `repos/${repo}/pulls/${pr}`,
			accept: "application/vnd.github.diff",
		}).pipe(
			Effect.map((outcome) => {
				if (outcome._tag === "Unreachable") return fail(outcome.reason);
				return outcome.status >= 200 && outcome.status < 300
					? ok(outcome.text)
					: fail(refusalText(outcome));
			}),
		),
	);

/** One check run at a commit. `conclusion` is `null` until `status` reaches `completed`. */
export interface CheckRun {
	readonly name: string;
	readonly status: string;
	readonly conclusion: string | null;
}

export interface CheckRunPage {
	/** What the platform declared at this commit — the denominator the `13` refusal compares against. */
	readonly declared: number;
	readonly runs: ReadonlyArray<CheckRun>;
}

/**
 * The check runs at one commit, paged, carrying the platform's own `total_count` beside them.
 *
 * The runs accumulate across pages while the declared total is read from the first — a later page's
 * total is the same number, and taking the first keeps a zero-run trailing page from lowering it.
 */
export const listCheckRuns = (repo: string, sha: string): Shell<Attempt<CheckRunPage>> =>
	authed((token) =>
		Effect.gen(function* () {
			const page = yield* pagedEnvelope(
				token,
				`repos/${repo}/commits/${sha}/check-runs`,
				"check_runs",
			);
			if (page._tag === "Failure") return page;
			const runs: CheckRun[] = [];
			for (const value of page.value.entries) {
				if (
					!isRecord(value) ||
					typeof value.name !== "string" ||
					typeof value.status !== "string"
				) {
					return fail("GitHub answered 200 but one entry is not a check run");
				}
				runs.push({
					name: value.name,
					status: value.status,
					conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
				});
			}
			return ok({declared: page.value.declared, runs});
		}),
	);

/** Whether a commit exists in the repository — the proven-absent half of `review ci`'s `7`. */
export const commitExists = (repo: string, sha: string): Shell<Existence<string>> =>
	authedExistence((token) =>
		restCall(token, {method: "GET", path: `repos/${repo}/commits/${sha}`}).pipe(
			Effect.map((outcome) =>
				existenceOf(outcome, (body) => {
					const resolved = isRecord(body) && typeof body.sha === "string" ? body.sha : "";
					return resolved === "" ? fail("GitHub answered 200 but named no commit") : ok(resolved);
				}),
			),
		),
	);

/** The login the invoking token authenticates as — half of the ACL lookup, and the upsert's key. */
export const viewerLogin: Shell<Attempt<string>> = authed((token) =>
	restCall(token, {method: "GET", path: "user"}).pipe(
		Effect.map((outcome) => {
			if (outcome._tag === "Unreachable") return fail(outcome.reason);
			if (outcome.status < 200 || outcome.status >= 300) {
				return fail(refusalText(outcome));
			}
			const login =
				isRecord(outcome.body) && typeof outcome.body.login === "string"
					? outcome.body.login.trim()
					: "";
			return login === "" ? fail("GitHub answered 200 but named no login") : ok(login);
		}),
	),
);

/**
 * One collaborator's repository permission — `admin` / `maintain` / `write` / `triage` / `read`.
 *
 * A 404 is a **proven** answer here (the login is not a collaborator, so it holds no permission) and
 * is deliberately not folded into the unreadable arm: the fence above it refuses either way, but the
 * two refusals say different true things.
 */
export const permissionFor = (repo: string, login: string): Shell<Existence<string>> =>
	authedExistence((token) =>
		restCall(token, {
			method: "GET",
			path: `repos/${repo}/collaborators/${login}/permission`,
		}).pipe(
			Effect.map((outcome) =>
				existenceOf(outcome, (body) => {
					const permission =
						isRecord(body) && typeof body.permission === "string" ? body.permission.trim() : "";
					return permission === ""
						? fail("GitHub answered 200 but named no permission")
						: ok(permission);
				}),
			),
		),
	);

/** Replace one issue comment's body — the edit half of the one-comment-per-namespace upsert. */
export const patchComment = (repo: string, id: number, body: string): Shell<Attempt<string>> =>
	authed((token) =>
		restCall(token, {
			method: "PATCH",
			path: `repos/${repo}/issues/comments/${id}`,
			body: {body},
		}).pipe(
			Effect.map((outcome) => {
				if (outcome._tag === "Unreachable") return fail(outcome.reason);
				if (outcome.status < 200 || outcome.status >= 300) {
					return fail(refusalText(outcome));
				}
				return isRecord(outcome.body) && typeof outcome.body.html_url === "string"
					? ok(outcome.body.html_url)
					: fail("GitHub answered 200 but its output is not an edited comment");
			}),
		),
	);

/**
 * The open pull requests the search index nominates for `tokens` — candidate numbers, never a proof.
 *
 * The index is a nomination surface only: it matches prose as readily as a link, and it lags a
 * fresh PR. A caller proving a PR traces to an issue reads each candidate's own record and its own
 * body; what this narrows is how many records that costs.
 *
 * **Why this survives #5850's retirement of the same read.** {@link openPullsClosing} replaced it
 * everywhere the question is "which PR closes this issue", and is authoritative there — an edge, not
 * an index, so it has no lag. It is built from closing keywords, so it cannot see a `Part of #N` PR
 * — the body shape `build --partial` emits for an epic child, and the normal shape for a lane task
 * that does not close its issue. That one shape is all this read is for. A caller wanting both kinds
 * reads the edge first and unions this nomination in behind it, so an index that has not caught up
 * with a fresh PR can only ever add candidates, never subtract the closing one.
 */
export const searchOpenPulls = (
	repo: string,
	tokens: ReadonlyArray<string>,
): Shell<Attempt<ReadonlyArray<number>>> =>
	authed((token) =>
		Effect.gen(function* () {
			const q = `repo:${repo} is:pr is:open ${tokens.join(" ")}`;
			const page = yield* pagedEnvelope(token, `search/issues?q=${encodeURIComponent(q)}`, "items");
			if (page._tag === "Failure") return page;
			// A nomination scan that stopped early reports "no open PR names this issue" over a scope
			// nobody proved was searched, which is a proven negative the caller then acts on.
			if (!page.value.exhausted) {
				return fail(
					`the search reached the ${PAGE_CAP}-page cap with another page still to come — this is not the whole list`,
				);
			}
			const numbers: number[] = [];
			for (const item of page.value.entries) {
				if (!isRecord(item) || typeof item.number !== "number") {
					return fail("GitHub answered 200 but its output is not a list of pull requests");
				}
				numbers.push(item.number);
			}
			return ok(numbers);
		}),
	);

/** One open pull request that declares it closes the issue: the number and the link to hand on. */
export interface ClosingPull {
	readonly number: number;
	readonly url: string;
}

const CLOSERS_QUERY =
	"query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issue(number:$number){closedByPullRequestsReferences(first:100,includeClosedPrs:true,after:$cursor){pageInfo{hasNextPage endCursor} nodes{number url state}}}}}";

/**
 * Every OPEN pull request that **declares it closes** `issue`, read off GitHub's own closing-issue
 * link edge and paged.
 *
 * v1 asked `search/issues` for `<issue> in:body`, which matches any prose quoting the number: a PR
 * closing a different issue but naming this one in a table came back as a candidate, and the
 * caller's several-hits refusal then parked a lane that had exactly one real PR (#5805). The edge
 * read here is the one GitHub builds from a closing keyword, so a mention is not a hit and
 * "several" means what the caller needs it to mean — two PRs each declaring they close this issue.
 *
 * `includeClosedPrs: true` plus an explicit `OPEN` filter, rather than the field's own exclusion:
 * that argument's name promises more than it delivers (a merged PR is still returned under
 * `false`), and the caller is asking about open PRs specifically.
 *
 * The answer is the whole set rather than a first hit: zero and several are facts a caller must be
 * able to refuse on, and a read that narrowed to one would invent the lane's PR.
 */
export const openPullsClosing = (
	repo: string,
	issue: number,
): Shell<Attempt<ReadonlyArray<ClosingPull>>> =>
	authed(
		(token): Api<Attempt<ReadonlyArray<ClosingPull>>> =>
			Effect.gen(function* () {
				const [owner, name] = repo.split("/");
				if (owner === undefined || name === undefined) return fail(`\`${repo}\` is not owner/name`);
				const out: ClosingPull[] = [];
				let cursor: string | null = null;
				for (let page = 0; page < PAGE_CAP; page++) {
					const outcome: Rest = yield* graphqlRead(token, CLOSERS_QUERY, {
						owner,
						name,
						number: issue,
						cursor,
					});
					if (outcome._tag === "Unreachable") return fail(outcome.reason);
					if (outcome.status < 200 || outcome.status >= 300) {
						return fail(refusalText(outcome));
					}
					const parsed: unknown = outcome.body;
					if (isRecord(parsed) && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
						return fail("GitHub answered 200 and the GraphQL query carried errors");
					}
					const data = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : null;
					const repository = data !== null && isRecord(data.repository) ? data.repository : null;
					const issueNode =
						repository !== null && isRecord(repository.issue) ? repository.issue : null;
					const set =
						issueNode !== null && isRecord(issueNode.closedByPullRequestsReferences)
							? issueNode.closedByPullRequestsReferences
							: null;
					if (set === null || !Array.isArray(set.nodes)) {
						return fail("GitHub answered 200 but its output is not a closing-pull page");
					}
					for (const node of set.nodes) {
						if (
							!isRecord(node) ||
							typeof node.number !== "number" ||
							typeof node.url !== "string" ||
							node.url === "" ||
							typeof node.state !== "string"
						) {
							return fail("GitHub answered 200 but one node is not a pull request");
						}
						if (node.state !== "OPEN") continue;
						out.push({number: node.number, url: node.url});
					}
					const info = isRecord(set.pageInfo) ? set.pageInfo : null;
					if (info === null || info.hasNextPage !== true) break;
					cursor = typeof info.endCursor === "string" ? info.endCursor : "";
					if (cursor === "") return fail("GitHub declared another page and named no cursor");
				}
				return ok(out);
			}),
	);

/** One pull request as a branch lookup sees it — enough to pick the newest and state what it is. */
export interface BranchPull {
	readonly number: number;
	readonly state: string;
	/** Non-null once it merged. `state` alone reads `closed` either way. */
	readonly mergedAt: string | null;
	readonly headSha: string;
	readonly createdAt: string;
}

/**
 * Every pull request whose head ref is `branch`, in any state, paged.
 *
 * `state=all` is load-bearing: a caller asking "what pull request does this work sit on" is often
 * asking about one that already closed, and an open-only read would answer `none` over it.
 */
export const pullsForBranch = (
	repo: string,
	branch: string,
): Shell<Attempt<ReadonlyArray<BranchPull>>> =>
	authed((token) =>
		Effect.gen(function* () {
			const owner = repo.split("/")[0] ?? "";
			const head = encodeURIComponent(`${owner}:${branch}`);
			const page = yield* pagedWithLinkProof(token, `repos/${repo}/pulls?state=all&head=${head}`);
			if (page._tag === "Failure") return page;
			if (!page.value.exhausted) {
				return fail(`the pull request list for \`${branch}\` was not read to its end`);
			}
			const out: BranchPull[] = [];
			for (const value of page.value.entries) {
				const headNode = isRecord(value) ? value.head : null;
				const sha = isRecord(headNode) && typeof headNode.sha === "string" ? headNode.sha : null;
				if (!isRecord(value) || typeof value.number !== "number" || sha === null) {
					return fail("GitHub answered 200 but one entry is not a pull request");
				}
				out.push({
					number: value.number,
					state: typeof value.state === "string" ? value.state : "",
					mergedAt: typeof value.merged_at === "string" ? value.merged_at : null,
					headSha: sha,
					createdAt: typeof value.created_at === "string" ? value.created_at : "",
				});
			}
			return ok(out);
		}),
	);
