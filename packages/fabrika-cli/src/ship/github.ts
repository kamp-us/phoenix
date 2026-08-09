/**
 * The GitHub surface the `ship` verbs read and write, beyond what `../io/pulls.ts` already serves.
 *
 * Two disciplines hold everywhere here and are stated once:
 *
 * - **Every `gh` exit status is read before the bytes are interpreted.** A failed read becomes an
 *   explicit `Failure`, never an empty string flowing onward as "nothing found" — roughly a third of
 *   v1's captures skipped this, and every scar in that family (#4216, #4223, #3716) is the same
 *   omission wearing a different symptom.
 * - **Every list read pages, and returns what the platform declared beside what it received.** A
 *   caller that cannot see both numbers cannot refuse a truncated read, and a truncated read that
 *   answers anyway is a verdict over unknown scope.
 *
 * REST throughout, with the one sanctioned GraphQL exception at the bottom: review-thread resolution
 * state and the resolve mutation have no REST equivalent.
 */
import {Effect} from "effect";
import {execCapture} from "../io/exec.ts";
import {type Attempt, fail, ok, type Shell} from "../io/git.ts";
import {
	absent,
	type Existence,
	httpStatusOf,
	present,
	splitJsonArrays,
	unknown,
} from "../io/issues.ts";
import {isRecord, parseJson} from "../io/json.ts";

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Every element of every page, or the failure that stopped the read. */
const pagedArray = (stdout: string): Attempt<ReadonlyArray<unknown>> => {
	const out: unknown[] = [];
	for (const page of splitJsonArrays(stdout)) {
		const parsed = parseJson(page);
		if (!Array.isArray(parsed)) return fail("`gh api` exited 0 but its output is not a list");
		out.push(...parsed);
	}
	return ok(out);
};

/** A `{total_count, <key>: []}` envelope, paged: entries accumulate, the declared total is page 1's. */
const pagedEnvelope = (
	stdout: string,
	key: string,
): Attempt<{declared: number; entries: ReadonlyArray<unknown>}> => {
	const entries: unknown[] = [];
	let declared: number | null = null;
	for (const page of splitJsonArrays(stdout)) {
		const parsed = parseJson(page);
		if (!isRecord(parsed) || !Array.isArray(parsed[key])) {
			return fail(`\`gh api\` exited 0 but its output carries no ${key} list`);
		}
		if (declared === null) {
			if (typeof parsed.total_count !== "number") {
				return fail("`gh api` exited 0 but the envelope declares no total_count");
			}
			declared = parsed.total_count;
		}
		entries.push(...parsed[key]);
	}
	return declared === null
		? fail("`gh api` exited 0 and printed no envelope at all")
		: ok({declared, entries});
};

// ── reviews and approvals ────────────────────────────────────────────────────────────────────────

export interface ReviewRecord {
	readonly login: string;
	readonly state: string;
	readonly commitId: string;
	readonly submittedAt: string;
}

/**
 * Every review on the PR, paged and **un-reduced**.
 *
 * Latest-per-author is computed by the caller after the pages are joined, never per page: v1's
 * per-page `group_by` could surface a page-1 stale approval past a page-2 revocation (#725's class).
 */
export const listReviews = (
	repo: string,
	pr: number,
): Shell<Attempt<ReadonlyArray<ReviewRecord>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/pulls/${pr}/reviews?per_page=100`,
		]);
		if (!r.ok) return fail(r.reason);
		const paged = pagedArray(r.stdout);
		if (paged._tag === "Failure") return paged;
		const reviews: ReviewRecord[] = [];
		for (const value of paged.value) {
			if (!isRecord(value) || typeof value.state !== "string") {
				return fail("`gh api` exited 0 but one entry is not a review");
			}
			reviews.push({
				login: isRecord(value.user) ? str(value.user.login) : "",
				state: value.state,
				commitId: str(value.commit_id),
				submittedAt: str(value.submitted_at),
			});
		}
		return ok(reviews);
	});

/** One team's members, paged. A 404 is proven — the team does not exist in this org. */
export const listTeamMembers = (
	org: string,
	team: string,
): Shell<Existence<ReadonlyArray<string>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`orgs/${org}/teams/${team}/members?per_page=100`,
		]);
		if (!r.ok) {
			return httpStatusOf(r.reason) === 404
				? absent<ReadonlyArray<string>>()
				: unknown<ReadonlyArray<string>>(r.reason);
		}
		const paged = pagedArray(r.stdout);
		if (paged._tag === "Failure") return unknown<ReadonlyArray<string>>(paged.reason);
		const logins: string[] = [];
		for (const value of paged.value) {
			if (!isRecord(value) || typeof value.login !== "string") {
				return unknown<ReadonlyArray<string>>("`gh api` exited 0 but one entry is not a member");
			}
			logins.push(value.login);
		}
		return present<ReadonlyArray<string>>(logins);
	});

// ── repository content at a ref ──────────────────────────────────────────────────────────────────

/**
 * One file's bytes at a ref, through the raw media type.
 *
 * The §CP boundary and the flag registry are both read this way and both read from the **base
 * branch**, never from the PR — a PR must not reclassify itself (#981).
 */
export const readFileAtRef = (repo: string, path: string, ref: string): Shell<Existence<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"-H",
			"Accept: application/vnd.github.raw",
			`repos/${repo}/contents/${path}?ref=${ref}`,
		]);
		if (!r.ok) {
			return httpStatusOf(r.reason) === 404 ? absent<string>() : unknown<string>(r.reason);
		}
		return present(r.stdout);
	});

// ── CI surfaces ──────────────────────────────────────────────────────────────────────────────────

/** One check run at a head, with the two fields the wedge split needs beyond name/status. */
export interface ShipCheckRun {
	readonly name: string;
	readonly status: string;
	readonly conclusion: string | null;
	/** `null` while the run has never started — half of the queued-but-wedged discriminator. */
	readonly startedAt: string | null;
	readonly id: number;
}

export interface CheckRunSet {
	readonly declared: number;
	readonly runs: ReadonlyArray<ShipCheckRun>;
}

/**
 * The check runs at one commit, paged, latest-per-context **after** the pages are joined.
 *
 * The REST read is deliberate: the GraphQL rollup lags reality by ~15 minutes and refused green PRs
 * for it (#3999). The aggregate `.conclusion` is never bound — red-wins-over-pending would mask an
 * unfinished gating check.
 */
export const listShipCheckRuns = (repo: string, sha: string): Shell<Attempt<CheckRunSet>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/commits/${sha}/check-runs?per_page=100`,
		]);
		if (!r.ok) return fail(r.reason);
		const enveloped = pagedEnvelope(r.stdout, "check_runs");
		if (enveloped._tag === "Failure") return enveloped;
		const runs: ShipCheckRun[] = [];
		for (const value of enveloped.value.entries) {
			if (!isRecord(value) || typeof value.name !== "string" || typeof value.status !== "string") {
				return fail("`gh api` exited 0 but one entry is not a check run");
			}
			runs.push({
				name: value.name,
				status: value.status,
				conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
				startedAt: typeof value.started_at === "string" ? value.started_at : null,
				id: typeof value.id === "number" ? value.id : 0,
			});
		}
		return ok({declared: enveloped.value.declared, runs});
	});

/** Latest-per-context: the highest run id wins, computed over the joined pages. */
export const latestPerContext = (
	runs: ReadonlyArray<ShipCheckRun>,
): ReadonlyArray<ShipCheckRun> => {
	const byName = new Map<string, ShipCheckRun>();
	for (const run of runs) {
		const held = byName.get(run.name);
		if (held === undefined || run.id >= held.id) byName.set(run.name, run);
	}
	return [...byName.values()];
};

/** The repository's workflow inventory — the `no-runs` state's first discriminator. */
export const listWorkflows = (repo: string): Shell<Attempt<number>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/actions/workflows?per_page=100`,
		]);
		if (!r.ok) return fail(r.reason);
		const enveloped = pagedEnvelope(r.stdout, "workflows");
		if (enveloped._tag === "Failure") return enveloped;
		const active = enveloped.value.entries.filter(
			(value) => isRecord(value) && value.state === "active",
		);
		return ok(active.length);
	});

/**
 * Whether one workflow file exists in the repository.
 *
 * The `absent` arm of `ship evidence` rests on this being a **successful** read that found nothing —
 * the foreign-repo degradation (ADR 0086) is a fact about the repo, and a failed read is not.
 */
export const workflowExists = (repo: string, file: string): Shell<Existence<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			`repos/${repo}/actions/workflows/${file}`,
			"--jq",
			".path",
		]);
		if (!r.ok) {
			return httpStatusOf(r.reason) === 404 ? absent<string>() : unknown<string>(r.reason);
		}
		const path = r.stdout.trim();
		return path === "" ? unknown<string>("`gh api` exited 0 but named no workflow") : present(path);
	});

/** Total workflow runs recorded at one head, **pre-dedupe** — the `no-runs` second discriminator. */
export const countWorkflowRuns = (repo: string, sha: string): Shell<Attempt<number>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			`repos/${repo}/actions/runs?head_sha=${sha}&per_page=1`,
		]);
		if (!r.ok) return fail(r.reason);
		const parsed = parseJson(r.stdout);
		return isRecord(parsed) && typeof parsed.total_count === "number"
			? ok(parsed.total_count)
			: fail("`gh api` exited 0 but the run list declares no total_count");
	});

/** The combined commit-status count at a head — the nudge's second zero-signal. */
export const countCommitStatuses = (repo: string, sha: string): Shell<Attempt<number>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", `repos/${repo}/commits/${sha}/status`]);
		if (!r.ok) return fail(r.reason);
		const parsed = parseJson(r.stdout);
		return isRecord(parsed) && typeof parsed.total_count === "number"
			? ok(parsed.total_count)
			: fail("`gh api` exited 0 but the status rollup declares no total_count");
	});

// ── run evidence ─────────────────────────────────────────────────────────────────────────────────

export interface WorkflowRun {
	readonly id: number;
	readonly name: string;
	readonly status: string;
	readonly conclusion: string | null;
}

/** The runs at exactly this head — `head_sha` match only, never a name or a date heuristic. */
export const listRunsAtHead = (
	repo: string,
	sha: string,
): Shell<Attempt<{declared: number; runs: ReadonlyArray<WorkflowRun>}>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`,
		]);
		if (!r.ok) return fail(r.reason);
		const enveloped = pagedEnvelope(r.stdout, "workflow_runs");
		if (enveloped._tag === "Failure") return enveloped;
		const runs: WorkflowRun[] = [];
		for (const value of enveloped.value.entries) {
			if (!isRecord(value) || typeof value.id !== "number") {
				return fail("`gh api` exited 0 but one entry is not a workflow run");
			}
			runs.push({
				id: value.id,
				name: str(value.name),
				status: str(value.status),
				conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
			});
		}
		return ok({declared: enveloped.value.declared, runs});
	});

export interface ArtifactRecord {
	readonly id: number;
	readonly name: string;
	readonly expired: boolean;
}

export const listRunArtifacts = (
	repo: string,
	runId: number,
): Shell<Attempt<{declared: number; artifacts: ReadonlyArray<ArtifactRecord>}>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
		]);
		if (!r.ok) return fail(r.reason);
		const enveloped = pagedEnvelope(r.stdout, "artifacts");
		if (enveloped._tag === "Failure") return enveloped;
		const artifacts: ArtifactRecord[] = [];
		for (const value of enveloped.value.entries) {
			if (!isRecord(value) || typeof value.id !== "number") {
				return fail("`gh api` exited 0 but one entry is not an artifact");
			}
			artifacts.push({id: value.id, name: str(value.name), expired: value.expired === true});
		}
		return ok({declared: enveloped.value.declared, artifacts});
	});

/**
 * Fetch one artifact into a per-run directory, prove it is a zip, and serve the manifest.
 *
 * The magic-number check is the #3716 fix made structural: a 503 body saved with a `.zip` name is
 * not a bundle, and the read that reported "no run-evidence bundle" for a bundle present the whole
 * time is exactly that byte sequence parsed as one. The directory is `mktemp -d` per run — a fixed
 * or PID-derived path lets two racing shippers read each other's bundle (#3718, #2281).
 */
export const fetchManifest = (
	repo: string,
	artifactId: number,
	directory: string,
): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const zip = `${directory}/run-evidence.zip`;
		const download = yield* execCapture("sh", [
			"-c",
			`gh api repos/${repo}/actions/artifacts/${artifactId}/zip > '${zip}'`,
		]);
		if (!download.ok) return fail(download.reason);
		const magic = yield* execCapture("sh", ["-c", `head -c 2 '${zip}'`]);
		if (!magic.ok) return fail(magic.reason);
		if (magic.stdout.slice(0, 2) !== "PK") {
			return fail("the fetched artifact is not a zip — a 503 body saved as .zip is not a bundle");
		}
		const manifest = yield* execCapture("sh", ["-c", `unzip -p '${zip}' manifest.json`]);
		return manifest.ok ? ok(manifest.stdout) : fail(manifest.reason);
	});

/** A per-run scratch directory, so two racing shippers never read each other's bundle. */
export const makeScratchDirectory: Shell<Attempt<string>> = Effect.gen(function* () {
	const r = yield* execCapture("mktemp", ["-d"]);
	if (!r.ok) return fail(r.reason);
	const path = r.stdout.trim();
	return path === "" ? fail("`mktemp -d` exited 0 but named no directory") : ok(path);
});

// ── timeline, commits, queue regime ──────────────────────────────────────────────────────────────

export interface TimelineEvent {
	readonly event: string;
	readonly createdAt: string;
}

/**
 * The PR's timeline, paged.
 *
 * A 30-event first page read as the whole history is #4193; `--paginate` is what makes the ejection
 * classification and the reopened count honest.
 */
export const pullTimeline = (
	repo: string,
	pr: number,
): Shell<Attempt<ReadonlyArray<TimelineEvent>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/issues/${pr}/timeline?per_page=100`,
		]);
		if (!r.ok) return fail(r.reason);
		const paged = pagedArray(r.stdout);
		if (paged._tag === "Failure") return paged;
		const events: TimelineEvent[] = [];
		for (const value of paged.value) {
			if (!isRecord(value) || typeof value.event !== "string") {
				return fail("`gh api` exited 0 but one entry is not a timeline event");
			}
			events.push({event: value.event, createdAt: str(value.created_at)});
		}
		return ok(events);
	});

/**
 * How far the inspected head sits behind the base — the #4477 base-drift notice.
 *
 * An approval solicited on a head that must move is destroyed by the rebase that moves it (#4521 is
 * three §CP approvals destroyed in one night), so the notice fires before one is asked for.
 */
export const behindBase = (repo: string, base: string, sha: string): Shell<Attempt<number>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			`repos/${repo}/compare/${base}...${sha}`,
			"--jq",
			".behind_by",
		]);
		if (!r.ok) return fail(r.reason);
		const behind = Number.parseInt(r.stdout.trim(), 10);
		return Number.isInteger(behind) ? ok(behind) : fail("`gh api` exited 0 but named no behind_by");
	});

/** The recent commit subjects on a branch — `ship reconcile`'s base-branch cross-check. */
export const branchSubjects = (
	repo: string,
	branch: string,
): Shell<Attempt<ReadonlyArray<string>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			`repos/${repo}/commits?sha=${branch}&per_page=50`,
			"--jq",
			".[].commit.message",
		]);
		if (!r.ok) return fail(r.reason);
		return ok(r.stdout.split("\n").filter((line) => line !== ""));
	});

/** One commit's author date — the window the nudge counts `reopened` events within. */
export const commitDate = (repo: string, sha: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			`repos/${repo}/commits/${sha}`,
			"--jq",
			".commit.committer.date",
		]);
		if (!r.ok) return fail(r.reason);
		const date = r.stdout.trim();
		return date === "" ? fail("`gh api` exited 0 but named no commit date") : ok(date);
	});

/**
 * Whether the base branch is queue-governed.
 *
 * Read off the **branch's** active rules, never this PR's queue history: a per-PR proxy exempts
 * exactly the parked intent `ship disarm` exists to clear.
 */
export const isQueueGoverned = (repo: string, branch: string): Shell<Attempt<boolean>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", `repos/${repo}/rules/branches/${branch}`]);
		if (!r.ok) return fail(r.reason);
		const parsed = parseJson(r.stdout);
		if (!Array.isArray(parsed)) return fail("`gh api` exited 0 but its output is not a rule list");
		return ok(parsed.some((rule) => isRecord(rule) && rule.type === "merge_queue"));
	});

// ── writes ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Arm the queue's auto-merge at the verified head.
 *
 * **There is no merge-method flag to pass, by construction.** The queue owns the method, and v1's
 * documented hazard is that a `--squash` alongside `--auto` conflicts with the queue and no-ops the
 * enqueue silently at exit 0. The arm has no REST surface — enabling auto-merge is a GraphQL
 * mutation — so it goes through `gh`'s own porcelain, which is not this group's GraphQL exception.
 */
export const armAutoMerge = (repo: string, pr: number): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["pr", "merge", String(pr), "--repo", repo, "--auto"]);
		return r.ok ? ok(undefined) : fail(r.reason);
	});

/** Clear a parked merge intent. Its exit status is never trusted — the caller re-reads. */
export const disableAutoMerge = (repo: string, pr: number): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"pr",
			"merge",
			String(pr),
			"--repo",
			repo,
			"--disable-auto",
		]);
		return r.ok ? ok(undefined) : fail(r.reason);
	});

/** Close or reopen a pull request. Each leg is read back by the caller; neither is trusted here. */
export const setPullState = (repo: string, pr: number, state: string): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"PATCH",
			`repos/${repo}/pulls/${pr}`,
			"-f",
			`state=${state}`,
		]);
		return r.ok ? ok(undefined) : fail(r.reason);
	});

// ── the sanctioned GraphQL exception ─────────────────────────────────────────────────────────────

export interface ThreadComment {
	readonly author: string;
	/** GraphQL `__typename` of the comment's author. Only a literal `Bot` unlocks anything. */
	readonly authorType: string;
	readonly body: string;
}

export interface ReviewThread {
	readonly id: string;
	readonly isResolved: boolean;
	readonly path: string | null;
	readonly line: number | null;
	readonly comments: ReadonlyArray<ThreadComment>;
	/** What the payload declared this thread holds, against what arrived. */
	readonly declaredComments: number;
}

const THREADS_QUERY =
	"query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){totalCount pageInfo{hasNextPage endCursor} nodes{id isResolved path line comments(first:100){totalCount nodes{body author{login __typename}}}}}}}}";

const threadOf = (value: unknown): ReviewThread | null => {
	if (!isRecord(value) || typeof value.id !== "string") return null;
	const comments = isRecord(value.comments) ? value.comments : null;
	const nodes = comments !== null && Array.isArray(comments.nodes) ? comments.nodes : [];
	return {
		id: value.id,
		isResolved: value.isResolved === true,
		path: typeof value.path === "string" ? value.path : null,
		line: typeof value.line === "number" ? value.line : null,
		declaredComments:
			comments !== null && typeof comments.totalCount === "number" ? comments.totalCount : 0,
		comments: nodes.map((node) => ({
			author: isRecord(node) && isRecord(node.author) ? str(node.author.login) : "",
			authorType: isRecord(node) && isRecord(node.author) ? str(node.author.__typename) : "",
			body: isRecord(node) ? str(node.body) : "",
		})),
	};
};

/**
 * Every review thread on the PR, **both layers paged and count-proved**.
 *
 * v1 read `first: 100` threads and one comment, unpaginated: a 101st unresolved human thread was
 * invisible to the merge gate, and a human's "no, this matters" reply on a bot thread was never
 * read at all.
 */
export const listReviewThreads = (
	repo: string,
	pr: number,
): Shell<Attempt<{declared: number; threads: ReadonlyArray<ReviewThread>}>> =>
	Effect.gen(function* () {
		const [owner, name] = repo.split("/");
		if (owner === undefined || name === undefined) return fail(`\`${repo}\` is not owner/name`);
		const threads: ReviewThread[] = [];
		let declared: number | null = null;
		let cursor: string | null = null;
		for (let page = 0; page < 50; page++) {
			const args = [
				"api",
				"graphql",
				"-f",
				`query=${THREADS_QUERY}`,
				"-F",
				`owner=${owner}`,
				"-F",
				`name=${name}`,
				"-F",
				`number=${pr}`,
			];
			if (cursor !== null) args.push("-F", `cursor=${cursor}`);
			const r = yield* execCapture("gh", args);
			if (!r.ok) return fail(r.reason);
			const parsed = parseJson(r.stdout);
			const data = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : null;
			const repository = data !== null && isRecord(data.repository) ? data.repository : null;
			const pull =
				repository !== null && isRecord(repository.pullRequest) ? repository.pullRequest : null;
			const set = pull !== null && isRecord(pull.reviewThreads) ? pull.reviewThreads : null;
			if (set === null || !Array.isArray(set.nodes) || typeof set.totalCount !== "number") {
				return fail("`gh api graphql` exited 0 but its output is not a review-thread page");
			}
			declared ??= set.totalCount;
			for (const node of set.nodes) {
				const thread = threadOf(node);
				if (thread === null) return fail("`gh api graphql` exited 0 but one node is not a thread");
				threads.push(thread);
			}
			const info = isRecord(set.pageInfo) ? set.pageInfo : null;
			if (info === null || info.hasNextPage !== true) break;
			cursor = str(info.endCursor);
			if (cursor === "") return fail("`gh api graphql` declared another page and named no cursor");
		}
		return declared === null
			? fail("`gh api graphql` exited 0 and printed no thread page at all")
			: ok({declared, threads});
	});

const REPLY_MUTATION =
	"mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{url}}}";

const RESOLVE_MUTATION =
	"mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}";

/** Post the rationale reply. It lands **before** the resolve, so an interrupted run is never silent. */
export const replyToThread = (thread: string, body: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"graphql",
			"-f",
			`query=${REPLY_MUTATION}`,
			"-F",
			`thread=${thread}`,
			"-F",
			`body=${body}`,
		]);
		if (!r.ok) return fail(r.reason);
		const parsed = parseJson(r.stdout);
		const data = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : null;
		const added =
			data !== null && isRecord(data.addPullRequestReviewThreadReply)
				? data.addPullRequestReviewThreadReply
				: null;
		const comment = added !== null && isRecord(added.comment) ? added.comment : null;
		return comment !== null && typeof comment.url === "string"
			? ok(comment.url)
			: fail("`gh api graphql` exited 0 but its output is not a posted reply");
	});

/** Fire the resolve. Its response is never the proof — the caller re-reads the thread. */
export const resolveThread = (thread: string): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"graphql",
			"-f",
			`query=${RESOLVE_MUTATION}`,
			"-F",
			`thread=${thread}`,
		]);
		return r.ok ? ok(undefined) : fail(r.reason);
	});
