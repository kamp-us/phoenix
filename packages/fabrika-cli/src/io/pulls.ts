/**
 * The pull-request surface the `review` verbs read and write: one PR's metadata, its changed-file
 * list, its diff bytes, the check runs at a commit, the invoking token's identity and repository
 * permission, and the comment edit an upsert needs.
 *
 * The `issues.ts` disciplines hold here unchanged — `gh api` REST and never GraphQL, every list read
 * paged, absent split from unreadable through {@link Existence}, and a shape that is not what was
 * asked for treated as a failure rather than an empty result.
 *
 * **Every list read returns what it received alongside what the platform declared.** A review whose
 * scope was silently truncated is a review over unknown scope, and the only way a caller can refuse
 * that is to be handed both numbers. The reads below never narrow to the received list alone.
 */
import {Effect} from "effect";
import {execCapture} from "./exec.ts";
import {type Attempt, fail, ok, type Shell} from "./git.ts";
import {
	absent,
	type Existence,
	httpStatusOf,
	pagedJson,
	parseTabRows,
	present,
	unknown,
} from "./issues.ts";
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

/** One open pull request as a body-trace lookup sees it: the number and the link to hand on. */
export interface TracingPull {
	readonly number: number;
	readonly url: string;
}

/**
 * Every OPEN pull request whose body mentions `issue`, paged.
 *
 * The lane's PR is read off the board and never off a driver's memory, so the answer is the whole
 * match set rather than a first hit: zero and several are facts a caller must be able to refuse on,
 * and a read that narrowed to one would invent the lane's PR whenever two branches trace to the
 * same issue.
 */
export const openPullsTracing = (
	repo: string,
	issue: number,
): Shell<Attempt<ReadonlyArray<TracingPull>>> =>
	Effect.gen(function* () {
		const q = `repo:${repo} is:pr is:open ${issue} in:body`;
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`search/issues?q=${encodeURIComponent(q)}&per_page=100`,
			"--jq",
			'.items[] | "\\(.number)\t\\(.html_url)"',
		]);
		if (!r.ok) return fail(r.reason);
		const rows = parseTabRows(r.stdout, 2);
		if (rows === null) return fail("`gh api` exited 0 but its output is not a list of pull rows");
		const out: TracingPull[] = [];
		for (const [number, url] of rows) {
			if (number === undefined || !/^\d+$/.test(number) || url === undefined || url === "") {
				return fail("`gh api` exited 0 but one row is not a pull request");
			}
			out.push({number: Number.parseInt(number, 10), url});
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
