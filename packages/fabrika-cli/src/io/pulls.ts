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
import {execCapture} from "./exec.ts";
import {type Attempt, fail, ok, type Shell} from "./git.ts";
import {absent, type Existence, httpStatusOf, pagedJson, present, unknown} from "./issues.ts";
import {isRecord, parseJson} from "./json.ts";

export interface PullRecord {
	readonly number: number;
	readonly state: string;
	readonly headSha: string;
	readonly body: string;
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
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", `repos/${repo}/pulls/${pr}`]);
		if (!r.ok) {
			return httpStatusOf(r.reason) === 404 ? absent<PullRecord>() : unknown<PullRecord>(r.reason);
		}
		const record = toPullRecord(parseJson(r.stdout));
		return record === null
			? unknown<PullRecord>("`gh api` exited 0 but its output is not a pull request")
			: present(record);
	});

/**
 * Every changed path on the PR, paged.
 *
 * Read as typed JSON rather than through `--jq .filename`: the count of entries is the completeness
 * proof, and a `jq` filter that errors mid-stream on one odd entry would shorten the list silently —
 * which is the truncation the caller is trying to detect.
 */
export const listPullFiles = (repo: string, pr: number): Shell<Attempt<ReadonlyArray<string>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/pulls/${pr}/files?per_page=100`,
		]);
		if (!r.ok) return fail(r.reason);
		const pages = pagedJson(r.stdout);
		if (pages._tag === "Failure") return pages;
		const files: string[] = [];
		for (const page of pages.value) {
			const parsed = parseJson(page);
			if (!Array.isArray(parsed)) {
				return fail("`gh api` exited 0 but its output is not a list of changed files");
			}
			for (const value of parsed) {
				if (!isRecord(value) || typeof value.filename !== "string") {
					return fail("`gh api` exited 0 but one entry is not a changed file");
				}
				files.push(value.filename);
			}
		}
		return ok(files);
	});

/** The unified diff bytes, served by the platform's diff media type. */
export const getPullDiff = (repo: string, pr: number): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"-H",
			"Accept: application/vnd.github.diff",
			`repos/${repo}/pulls/${pr}`,
		]);
		return r.ok ? ok(r.stdout) : fail(r.reason);
	});

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
 * `--paginate` concatenates one `{total_count, check_runs}` object per page, so the runs accumulate
 * across pages while the declared total is read from the first — a later page's total is the same
 * number, and taking the first keeps a zero-run trailing page from lowering it.
 */
export const listCheckRuns = (repo: string, sha: string): Shell<Attempt<CheckRunPage>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/commits/${sha}/check-runs?per_page=100`,
		]);
		if (!r.ok) return fail(r.reason);
		const pages = pagedJson(r.stdout);
		if (pages._tag === "Failure") return pages;
		const runs: CheckRun[] = [];
		let declared: number | null = null;
		for (const page of pages.value) {
			const parsed = parseJson(page);
			if (!isRecord(parsed) || !Array.isArray(parsed.check_runs)) {
				return fail("`gh api` exited 0 but its output is not a check-run rollup");
			}
			if (declared === null) {
				if (typeof parsed.total_count !== "number") {
					return fail("`gh api` exited 0 but the check-run rollup declares no total_count");
				}
				declared = parsed.total_count;
			}
			for (const value of parsed.check_runs) {
				if (
					!isRecord(value) ||
					typeof value.name !== "string" ||
					typeof value.status !== "string"
				) {
					return fail("`gh api` exited 0 but one entry is not a check run");
				}
				runs.push({
					name: value.name,
					status: value.status,
					conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
				});
			}
		}
		return declared === null
			? fail("`gh api` exited 0 and printed no check-run rollup at all")
			: ok({declared, runs});
	});

/** Whether a commit exists in the repository — the proven-absent half of `review ci`'s `7`. */
export const commitExists = (repo: string, sha: string): Shell<Existence<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", `repos/${repo}/commits/${sha}`, "--jq", ".sha"]);
		if (!r.ok) {
			return httpStatusOf(r.reason) === 404 ? absent<string>() : unknown<string>(r.reason);
		}
		const resolved = r.stdout.trim();
		return resolved === ""
			? unknown<string>("`gh api` exited 0 but named no commit")
			: present(resolved);
	});

/** The login the invoking token authenticates as — half of the ACL lookup, and the upsert's key. */
export const viewerLogin: Shell<Attempt<string>> = Effect.gen(function* () {
	const r = yield* execCapture("gh", ["api", "user", "--jq", ".login"]);
	if (!r.ok) return fail(r.reason);
	const login = r.stdout.trim();
	return login === "" ? fail("`gh api` exited 0 but named no login") : ok(login);
});

/**
 * One collaborator's repository permission — `admin` / `maintain` / `write` / `triage` / `read`.
 *
 * A 404 is a **proven** answer here (the login is not a collaborator, so it holds no permission) and
 * is deliberately not folded into the unreadable arm: the fence above it refuses either way, but the
 * two refusals say different true things.
 */
export const permissionFor = (repo: string, login: string): Shell<Existence<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			`repos/${repo}/collaborators/${login}/permission`,
			"--jq",
			".permission",
		]);
		if (!r.ok) {
			return httpStatusOf(r.reason) === 404 ? absent<string>() : unknown<string>(r.reason);
		}
		const permission = r.stdout.trim();
		return permission === ""
			? unknown<string>("`gh api` exited 0 but named no permission")
			: present(permission);
	});

/** Replace one issue comment's body — the edit half of the one-comment-per-namespace upsert. */
export const patchComment = (repo: string, id: number, body: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"PATCH",
			`repos/${repo}/issues/comments/${id}`,
			"-f",
			`body=${body}`,
		]);
		if (!r.ok) return fail(r.reason);
		const parsed = parseJson(r.stdout);
		return isRecord(parsed) && typeof parsed.html_url === "string"
			? ok(parsed.html_url)
			: fail("`gh api` exited 0 but its output is not an edited comment");
	});

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
	Effect.gen(function* () {
		const [owner, name] = repo.split("/");
		if (owner === undefined || name === undefined) return fail(`\`${repo}\` is not owner/name`);
		const out: ClosingPull[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < 50; page++) {
			const args = [
				"api",
				"graphql",
				"-f",
				`query=${CLOSERS_QUERY}`,
				"-F",
				`owner=${owner}`,
				"-F",
				`name=${name}`,
				"-F",
				`number=${issue}`,
			];
			if (cursor !== null) args.push("-F", `cursor=${cursor}`);
			const r = yield* execCapture("gh", args);
			if (!r.ok) return fail(r.reason);
			const parsed = parseJson(r.stdout);
			const data = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : null;
			const repository = data !== null && isRecord(data.repository) ? data.repository : null;
			const issueNode = repository !== null && isRecord(repository.issue) ? repository.issue : null;
			const set =
				issueNode !== null && isRecord(issueNode.closedByPullRequestsReferences)
					? issueNode.closedByPullRequestsReferences
					: null;
			if (set === null || !Array.isArray(set.nodes)) {
				return fail("`gh api graphql` exited 0 but its output is not a closing-pull page");
			}
			for (const node of set.nodes) {
				if (
					!isRecord(node) ||
					typeof node.number !== "number" ||
					typeof node.url !== "string" ||
					node.url === "" ||
					typeof node.state !== "string"
				) {
					return fail("`gh api graphql` exited 0 but one node is not a pull request");
				}
				if (node.state !== "OPEN") continue;
				out.push({number: node.number, url: node.url});
			}
			const info = isRecord(set.pageInfo) ? set.pageInfo : null;
			if (info === null || info.hasNextPage !== true) break;
			cursor = typeof info.endCursor === "string" ? info.endCursor : "";
			if (cursor === "") return fail("`gh api graphql` declared another page and named no cursor");
		}
		return ok(out);
	});

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
	Effect.gen(function* () {
		const owner = repo.split("/")[0] ?? "";
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/pulls?state=all&per_page=100&head=${encodeURIComponent(`${owner}:${branch}`)}`,
		]);
		if (!r.ok) return fail(r.reason);
		const pages = pagedJson(r.stdout);
		if (pages._tag === "Failure") return pages;
		const out: BranchPull[] = [];
		for (const page of pages.value) {
			const parsed = parseJson(page);
			if (!Array.isArray(parsed)) {
				return fail("`gh api` exited 0 but its output is not a list of pull requests");
			}
			for (const value of parsed) {
				const head = isRecord(value) ? value.head : null;
				const sha = isRecord(head) && typeof head.sha === "string" ? head.sha : null;
				if (!isRecord(value) || typeof value.number !== "number" || sha === null) {
					return fail("`gh api` exited 0 but one entry is not a pull request");
				}
				out.push({
					number: value.number,
					state: typeof value.state === "string" ? value.state : "",
					mergedAt: typeof value.merged_at === "string" ? value.merged_at : null,
					headSha: sha,
					createdAt: typeof value.created_at === "string" ? value.created_at : "",
				});
			}
		}
		return ok(out);
	});
