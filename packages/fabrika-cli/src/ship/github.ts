/**
 * The GitHub surface the `ship` verbs read and write, beyond what `../io/pulls.ts` already serves.
 *
 * Two disciplines hold everywhere here and are stated once:
 *
 * - **Every response's status is read before its bytes are interpreted.** A failed read becomes an
 *   explicit `Failure`, never an empty string flowing onward as "nothing found" — roughly a third of
 *   v1's captures skipped this, and every scar in that family (#4216, #4223, #3716) is the same
 *   omission wearing a different symptom.
 * - **Every list read pages, and returns its own completeness proof beside what it received.** A
 *   caller that cannot see the proof cannot refuse a truncated read, and a truncated read that
 *   answers anyway is a verdict over unknown scope. Which proof depends on what the platform
 *   declares: an envelope read (`total_count`) proves completeness by the declared count; a bare-array
 *   read (reviews, timeline) declares no count at all, so its proof is **exhausted pagination** — a
 *   terminal page carrying no `rel="next"` link, which the transport now reads off the `Link` header
 *   natively instead of parsing `gh api -i` output back out of a printed status line.
 *
 * The transport is `../io/gh-api.ts`, not a `gh` subprocess. REST throughout, with two of the three
 * carves ADR 0315 records: the review-thread block at the bottom, and the auto-merge mutation.
 * Neither has a REST route at all. The third is `openPullsClosing` in `../io/pulls.ts`.
 */

import {writeFile} from "node:fs/promises";
import {Effect} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {execCapture} from "../io/exec.ts";
import {
	type Api,
	ambientToken,
	authed,
	authedExistence,
	pagedEnvelope as envelopeOverHttp,
	existenceOf,
	graphqlRead,
	pagedWithLinkProof as linkProofOverHttp,
	onTransport,
	PAGE_CAP,
	type Rest,
	restRead,
} from "../io/gh-api.ts";
import {type Attempt, fail, ok, type Shell} from "../io/git.ts";
import {absent, type Existence, present, unknown} from "../io/issues.ts";
import {isRecord} from "../io/json.ts";

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const API_ROOT = "https://api.github.com";

const headersFor = (token: string, accept: string): Record<string, string> => ({
	authorization: `token ${token}`,
	accept,
	"x-github-api-version": "2022-11-28",
	"user-agent": "fabrika-cli",
});

const endpoint = (path: string): string => `${API_ROOT}/${path.replace(/^\//, "")}`;

/** One served response, or the reason none arrived. */
type Delivered<A> =
	| {readonly _tag: "Delivered"; readonly status: number; readonly value: A}
	| {readonly _tag: "Unreachable"; readonly reason: string};

/**
 * The three legs `../io/gh-api.ts` does not carry: a raw media type, a PATCH body, and raw bytes.
 *
 * They live here rather than in the client because five sibling ports are cutting from the same
 * base and no child owns that file — #6693 tracks hoisting them, which is where they belong once
 * the parallel ports have landed.
 */
const deliver = <A>(
	request: HttpClientRequest.HttpClientRequest,
	read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, unknown>,
): Api<Delivered<A>> =>
	HttpClient.execute(request).pipe(
		Effect.flatMap((response) =>
			Effect.map(read(response), (value) => ({
				_tag: "Delivered" as const,
				status: response.status,
				value,
			})),
		),
		Effect.catch((error: unknown) =>
			Effect.succeed({
				_tag: "Unreachable" as const,
				reason: `the GitHub API could not be reached: ${String(error)}`,
			}),
		),
	);

export interface ReviewRecord {
	readonly login: string;
	readonly state: string;
	readonly commitId: string;
	readonly submittedAt: string;
}

export interface ReviewRead {
	readonly reviews: ReadonlyArray<ReviewRecord>;
	/** The completeness proof: a terminal page carrying no `rel="next"`. Reviews declare no count. */
	readonly exhausted: boolean;
}

/**
 * Every review on the PR, paged and **un-reduced**.
 *
 * Latest-per-author is computed by the caller after the pages are joined, never per page: v1's
 * per-page `group_by` could surface a page-1 stale approval past a page-2 revocation (#725's class).
 */
export const listReviews = (repo: string, pr: number): Shell<Attempt<ReviewRead>> =>
	authed((token) =>
		Effect.map(linkProofOverHttp(token, `repos/${repo}/pulls/${pr}/reviews`), (paged) => {
			if (paged._tag === "Failure") return paged;
			const reviews: ReviewRecord[] = [];
			for (const value of paged.value.entries) {
				if (!isRecord(value) || typeof value.state !== "string") {
					return fail("GitHub answered 200 but one entry is not a review");
				}
				reviews.push({
					login: isRecord(value.user) ? str(value.user.login) : "",
					state: value.state,
					commitId: str(value.commit_id),
					submittedAt: str(value.submitted_at),
				});
			}
			return ok({reviews, exhausted: paged.value.exhausted});
		}),
	);

/**
 * A paged bare-array read whose 404 stays a **proven absence**.
 *
 * `pagedWithLinkProof` collapses every non-2xx into one failure, which is right where absence is not
 * a distinct answer. It is a distinct answer here: a team that does not exist in the org and a team
 * that could not be read decide different things.
 */
const pagedForExistence = (token: string, path: string): Api<Existence<ReadonlyArray<unknown>>> =>
	Effect.gen(function* () {
		const entries: unknown[] = [];
		for (let page = 1; page <= PAGE_CAP; page++) {
			const outcome = yield* restRead(token, "GET", `${path}?per_page=100&page=${page}`);
			if (outcome._tag === "Unreachable") {
				return unknown<ReadonlyArray<unknown>>(outcome.reason);
			}
			if (outcome.status === 404) return absent<ReadonlyArray<unknown>>();
			if (outcome.status < 200 || outcome.status >= 300) {
				return unknown<ReadonlyArray<unknown>>(`GitHub answered HTTP ${outcome.status}`);
			}
			if (!Array.isArray(outcome.body)) {
				return unknown<ReadonlyArray<unknown>>("GitHub answered 200 but its body is not a list");
			}
			entries.push(...outcome.body);
			if (!/<[^>]*>\s*;\s*rel="next"/i.test(outcome.headers.link ?? "")) {
				return present<ReadonlyArray<unknown>>(entries);
			}
		}
		return unknown<ReadonlyArray<unknown>>(
			`GitHub declared another page past ${PAGE_CAP} — the read is truncated`,
		);
	});

/**
 * The repository's default branch, on the ambient credential.
 *
 * A second reading of `build/github.ts`'s `defaultBranch` only because that one publishes `env` and
 * `HttpClient` up into its callers; `../ship/roster.ts` is reached from a hundred `Shell<…>` sites
 * that thread neither. #6693 folds the two once one convention wins.
 */
export const defaultBranch = (repo: string): Shell<Attempt<string>> =>
	authed((token) =>
		Effect.map(restRead(token, "GET", `repos/${repo}`), (outcome) => {
			if (outcome._tag === "Unreachable") return fail(outcome.reason);
			if (outcome.status < 200 || outcome.status >= 300) {
				return fail(`GitHub answered HTTP ${outcome.status}`);
			}
			const name = isRecord(outcome.body) ? outcome.body.default_branch : undefined;
			return typeof name === "string" && name.trim() !== ""
				? ok(name.trim())
				: fail("GitHub answered 200 but named no default branch");
		}),
	);

/** One team's members, paged. A 404 is proven — the team does not exist in this org. */
export const listTeamMembers = (
	org: string,
	team: string,
): Shell<Existence<ReadonlyArray<string>>> =>
	authedExistence((token) =>
		Effect.map(
			pagedForExistence(token, `orgs/${org}/teams/${team}/members`),
			(read): Existence<ReadonlyArray<string>> => {
				if (read._tag !== "Present") return read;
				const logins: string[] = [];
				for (const value of read.value) {
					if (!isRecord(value) || typeof value.login !== "string") {
						return unknown<ReadonlyArray<string>>(
							"GitHub answered 200 but one entry is not a member",
						);
					}
					logins.push(value.login);
				}
				return present<ReadonlyArray<string>>(logins);
			},
		),
	);

/**
 * One file's bytes at a ref, through the raw media type.
 *
 * The §CP boundary and the flag registry are both read this way and both read from the **base
 * branch**, never from the PR — a PR must not reclassify itself (#981).
 */
export const readFileAtRef = (repo: string, path: string, ref: string): Shell<Existence<string>> =>
	authedExistence((token) =>
		Effect.map(
			deliver(
				HttpClientRequest.get(endpoint(`repos/${repo}/contents/${path}?ref=${ref}`)).pipe(
					HttpClientRequest.setHeaders(headersFor(token, "application/vnd.github.raw")),
				),
				(response) => response.text,
			),
			(outcome): Existence<string> => {
				if (outcome._tag === "Unreachable") return unknown<string>(outcome.reason);
				if (outcome.status === 404) return absent<string>();
				if (outcome.status < 200 || outcome.status >= 300) {
					return unknown<string>(`GitHub answered HTTP ${outcome.status}`);
				}
				return present(outcome.value);
			},
		),
	);

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
	authed((token) =>
		Effect.map(
			envelopeOverHttp(token, `repos/${repo}/commits/${sha}/check-runs`, "check_runs"),
			(enveloped) => {
				if (enveloped._tag === "Failure") return enveloped;
				const runs: ShipCheckRun[] = [];
				for (const value of enveloped.value.entries) {
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
						startedAt: typeof value.started_at === "string" ? value.started_at : null,
						id: typeof value.id === "number" ? value.id : 0,
					});
				}
				return ok({declared: enveloped.value.declared, runs});
			},
		),
	);

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

/**
 * The repository's active workflow inventory, each entry as the platform addresses it: its `path`.
 *
 * A repo-authored workflow carries its file path (`.github/workflows/ci.yml`); one the platform
 * provides on the repo's behalf carries a synthetic `dynamic/<provider>/<name>`. Telling those two
 * apart is what `../review/gate-coverage.ts` needs, and the path is the only field that says it.
 */
export const listWorkflowPaths = (repo: string): Shell<Attempt<ReadonlyArray<string>>> =>
	authed((token) =>
		Effect.map(
			envelopeOverHttp(token, `repos/${repo}/actions/workflows`, "workflows"),
			(enveloped) => {
				if (enveloped._tag === "Failure") return enveloped;
				const active = enveloped.value.entries.filter(
					(value) => isRecord(value) && value.state === "active",
				);
				return ok(active.map((value) => str((value as Record<string, unknown>).path)));
			},
		),
	);

/**
 * The repository's workflow inventory — the `no-runs` state's first discriminator.
 *
 * Derived from {@link listWorkflowPaths} rather than issuing its own read: the count and the paths
 * are one fact about the repo, and two readers of one endpoint are two answers that can disagree.
 */
export const listWorkflows = (repo: string): Shell<Attempt<number>> =>
	Effect.map(listWorkflowPaths(repo), (read) =>
		read._tag === "Failure" ? read : ok(read.value.length),
	);

/**
 * Whether one workflow file exists in the repository.
 *
 * The `absent` arm of `ship evidence` rests on this being a **successful** read that found nothing —
 * the foreign-repo degradation (ADR 0086) is a fact about the repo, and a failed read is not.
 */
export const workflowExists = (repo: string, file: string): Shell<Existence<string>> =>
	authedExistence((token) =>
		Effect.map(
			restRead(token, "GET", `repos/${repo}/actions/workflows/${file}`),
			(outcome): Existence<string> =>
				existenceOf(outcome, (body) => {
					const path = isRecord(body) ? str(body.path).trim() : "";
					return path === "" ? fail("GitHub answered 200 but named no workflow") : ok(path);
				}),
		),
	);

/** Total workflow runs recorded at one head, **pre-dedupe** — the `no-runs` second discriminator. */
export const countWorkflowRuns = (repo: string, sha: string): Shell<Attempt<number>> =>
	authed((token) =>
		Effect.map(
			restRead(token, "GET", `repos/${repo}/actions/runs?head_sha=${sha}&per_page=1`),
			(outcome) =>
				readDeclared(outcome, "GitHub answered 200 but the run list declares no total_count"),
		),
	);

/** The combined commit-status count at a head — the nudge's second zero-signal. */
export const countCommitStatuses = (repo: string, sha: string): Shell<Attempt<number>> =>
	authed((token) =>
		Effect.map(restRead(token, "GET", `repos/${repo}/commits/${sha}/status`), (outcome) =>
			readDeclared(outcome, "GitHub answered 200 but the status rollup declares no total_count"),
		),
	);

/** One 2xx JSON body, or the failure that says why there is none to read. */
const bodyOf = (outcome: Rest): Attempt<unknown> => {
	if (outcome._tag === "Unreachable") return fail(outcome.reason);
	if (outcome.status < 200 || outcome.status >= 300) {
		return fail(`GitHub answered HTTP ${outcome.status}`);
	}
	return ok(outcome.body);
};

const readDeclared = (outcome: Rest, missing: string): Attempt<number> => {
	const body = bodyOf(outcome);
	if (body._tag === "Failure") return body;
	return isRecord(body.value) && typeof body.value.total_count === "number"
		? ok(body.value.total_count)
		: fail(missing);
};

export interface WorkflowRun {
	readonly id: number;
	readonly name: string;
	readonly status: string;
	readonly conclusion: string | null;
	/** When the run finished, or `null` while it has not — the freshness window's left operand. */
	readonly completedAt: string | null;
	/** The workflow this run came from, as {@link listWorkflowPaths} addresses it. */
	readonly path: string;
}

/** The runs at exactly this head — `head_sha` match only, never a name or a date heuristic. */
export const listRunsAtHead = (
	repo: string,
	sha: string,
): Shell<Attempt<{declared: number; runs: ReadonlyArray<WorkflowRun>}>> =>
	authed((token) =>
		Effect.map(
			envelopeOverHttp(token, `repos/${repo}/actions/runs?head_sha=${sha}`, "workflow_runs"),
			(enveloped) => {
				if (enveloped._tag === "Failure") return enveloped;
				const runs: WorkflowRun[] = [];
				for (const value of enveloped.value.entries) {
					if (!isRecord(value) || typeof value.id !== "number") {
						return fail("GitHub answered 200 but one entry is not a workflow run");
					}
					runs.push({
						id: value.id,
						name: str(value.name),
						status: str(value.status),
						conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
						completedAt: typeof value.completed_at === "string" ? value.completed_at : null,
						path: str(value.path),
					});
				}
				return ok({declared: enveloped.value.declared, runs});
			},
		),
	);

export interface ArtifactRecord {
	readonly id: number;
	readonly name: string;
	readonly expired: boolean;
}

export const listRunArtifacts = (
	repo: string,
	runId: number,
): Shell<Attempt<{declared: number; artifacts: ReadonlyArray<ArtifactRecord>}>> =>
	authed((token) =>
		Effect.map(
			envelopeOverHttp(token, `repos/${repo}/actions/runs/${runId}/artifacts`, "artifacts"),
			(enveloped) => {
				if (enveloped._tag === "Failure") return enveloped;
				const artifacts: ArtifactRecord[] = [];
				for (const value of enveloped.value.entries) {
					if (!isRecord(value) || typeof value.id !== "number") {
						return fail("GitHub answered 200 but one entry is not an artifact");
					}
					artifacts.push({id: value.id, name: str(value.name), expired: value.expired === true});
				}
				return ok({declared: enveloped.value.declared, artifacts});
			},
		),
	);

/** The zip's first two bytes. A 503 body saved with a `.zip` name does not carry them. */
const isZip = (bytes: Uint8Array): boolean => bytes[0] === 0x50 && bytes[1] === 0x4b;

/**
 * Fetch one artifact into a per-run directory, prove it is a zip, and serve the manifest.
 *
 * The magic-number check is the #3716 fix made structural: a 503 body saved with a `.zip` name is
 * not a bundle, and the read that reported "no run-evidence bundle" for a bundle present the whole
 * time is exactly that byte sequence parsed as one. The directory is `mktemp -d` per run — a fixed
 * or PID-derived path lets two racing shippers read each other's bundle (#3718, #2281).
 *
 * The zip endpoint answers `302` to a signed storage URL, and the redirect is followed by the
 * runtime rather than by this leg: Node's global `fetch` is undici, whose redirect step deletes
 * `authorization` when the location's origin differs from the current one
 * (`undici/lib/web/fetch/index.js`, the fetch spec's CORS non-wildcard header rule). That is the
 * behaviour this endpoint needs — the storage URL carries its own signature in the query string and
 * rejects a bearer credential it did not issue — so the leg neither disables redirects nor re-sends
 * the token.
 */
export const fetchManifest = (
	repo: string,
	artifactId: number,
	directory: string,
): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const zip = `${directory}/run-evidence.zip`;
		const token = yield* ambientToken;
		if (token._tag === "Failure") return token;
		const download = yield* onTransport(
			deliver(
				HttpClientRequest.get(endpoint(`repos/${repo}/actions/artifacts/${artifactId}/zip`)).pipe(
					HttpClientRequest.setHeaders(headersFor(token.value, "application/vnd.github+json")),
				),
				(response) => Effect.map(response.arrayBuffer, (buffer) => new Uint8Array(buffer)),
			),
		);
		if (download._tag === "Unreachable") return fail(download.reason);
		if (download.status < 200 || download.status >= 300) {
			return fail(`GitHub answered HTTP ${download.status}`);
		}
		if (!isZip(download.value)) {
			return fail("the fetched artifact is not a zip — a 503 body saved as .zip is not a bundle");
		}
		const written = yield* Effect.tryPromise({
			try: () => writeFile(zip, download.value),
			catch: (cause) => `the artifact could not be written: ${String(cause)}`,
		}).pipe(Effect.match({onFailure: fail, onSuccess: () => ok(undefined)}));
		if (written._tag === "Failure") return written;
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

export interface TimelineEvent {
	readonly event: string;
	readonly createdAt: string;
}

export interface TimelineRead {
	readonly events: ReadonlyArray<TimelineEvent>;
	/** The completeness proof: a terminal page carrying no `rel="next"`. The timeline declares no count. */
	readonly exhausted: boolean;
}

/**
 * The PR's timeline, paged, with the pagination-exhaustion proof its callers refuse on.
 *
 * A 30-event first page read as the whole history is #4193; walking to a terminal page with no
 * `next` link is what makes the ejection classification and the reopened count honest.
 */
export const pullTimeline = (repo: string, pr: number): Shell<Attempt<TimelineRead>> =>
	authed((token) =>
		Effect.map(linkProofOverHttp(token, `repos/${repo}/issues/${pr}/timeline`), (paged) => {
			if (paged._tag === "Failure") return paged;
			const events: TimelineEvent[] = [];
			for (const value of paged.value.entries) {
				if (!isRecord(value) || typeof value.event !== "string") {
					return fail("GitHub answered 200 but one entry is not a timeline event");
				}
				events.push({event: value.event, createdAt: str(value.created_at)});
			}
			return ok({events, exhausted: paged.value.exhausted});
		}),
	);

/**
 * How far the inspected head sits behind the base — the #4477 base-drift notice.
 *
 * An approval solicited on a head that must move is destroyed by the rebase that moves it (#4521 is
 * three §CP approvals destroyed in one night), so the notice fires before one is asked for.
 */
export const behindBase = (repo: string, base: string, sha: string): Shell<Attempt<number>> =>
	authed((token) =>
		Effect.map(restRead(token, "GET", `repos/${repo}/compare/${base}...${sha}`), (outcome) => {
			const body = bodyOf(outcome);
			if (body._tag === "Failure") return body;
			const behind = isRecord(body.value) ? body.value.behind_by : undefined;
			return typeof behind === "number" && Number.isInteger(behind)
				? ok(behind)
				: fail("GitHub answered 200 but named no behind_by");
		}),
	);

/** The recent commit subjects on a branch — `ship reconcile`'s base-branch cross-check. */
export const branchSubjects = (
	repo: string,
	branch: string,
): Shell<Attempt<ReadonlyArray<string>>> =>
	authed((token) =>
		Effect.map(
			restRead(token, "GET", `repos/${repo}/commits?sha=${branch}&per_page=50`),
			(outcome) => {
				const body = bodyOf(outcome);
				if (body._tag === "Failure") return body;
				if (!Array.isArray(body.value)) {
					return fail("GitHub answered 200 but its output is not a commit list");
				}
				const subjects: string[] = [];
				for (const entry of body.value) {
					const commit = isRecord(entry) && isRecord(entry.commit) ? entry.commit : null;
					if (commit === null) return fail("GitHub answered 200 but one entry is not a commit");
					const message = str(commit.message);
					if (message !== "") subjects.push(message);
				}
				return ok(subjects);
			},
		),
	);

/** One commit's author date — the window the nudge counts `reopened` events within. */
export const commitDate = (repo: string, sha: string): Shell<Attempt<string>> =>
	authed((token) =>
		Effect.map(restRead(token, "GET", `repos/${repo}/commits/${sha}`), (outcome) => {
			const body = bodyOf(outcome);
			if (body._tag === "Failure") return body;
			const commit = isRecord(body.value) && isRecord(body.value.commit) ? body.value.commit : null;
			const committer = commit !== null && isRecord(commit.committer) ? commit.committer : null;
			const date = committer === null ? "" : str(committer.date).trim();
			return date === "" ? fail("GitHub answered 200 but named no commit date") : ok(date);
		}),
	);

/**
 * Whether the base branch is queue-governed.
 *
 * Read off the **branch's** active rules, never this PR's queue history: a per-PR proxy exempts
 * exactly the parked intent `ship disarm` exists to clear.
 */
export const isQueueGoverned = (repo: string, branch: string): Shell<Attempt<boolean>> =>
	authed((token) =>
		Effect.map(restRead(token, "GET", `repos/${repo}/rules/branches/${branch}`), (outcome) => {
			const body = bodyOf(outcome);
			if (body._tag === "Failure") return body;
			if (!Array.isArray(body.value)) {
				return fail("GitHub answered 200 but its output is not a rule list");
			}
			return ok(body.value.some((rule) => isRecord(rule) && rule.type === "merge_queue"));
		}),
	);

/**
 * What GitHub says about whether this PR can merge — **and whether it has said anything yet**.
 *
 * `mergeable` is computed lazily: the first read after a push routinely returns `null` with
 * `mergeable_state: "unknown"` while the background job runs. That is the platform declining to
 * answer, not an answer, so the two are kept apart here and the caller polls rather than reading the
 * indefinite value as green.
 */
export interface Mergeability {
	readonly mergeable: boolean | null;
	readonly state: string;
}

/** `mergeable: null` or `mergeable_state: "unknown"` — the platform has not computed it yet. */
export const isIndefinite = (read: Mergeability): boolean =>
	read.mergeable === null || read.state === "" || read.state === "unknown";

export const readMergeability = (repo: string, pr: number): Shell<Attempt<Mergeability>> =>
	authed((token) =>
		Effect.map(restRead(token, "GET", `repos/${repo}/pulls/${pr}`), (outcome) => {
			const body = bodyOf(outcome);
			if (body._tag === "Failure") return body;
			if (!isRecord(body.value)) {
				return fail("GitHub answered 200 but its output is not a pull request");
			}
			return ok({
				mergeable: typeof body.value.mergeable === "boolean" ? body.value.mergeable : null,
				state: str(body.value.mergeable_state),
			});
		}),
	);

/** One GraphQL round trip, with the endpoint's own `errors` array read as the refusal it is. */
const graphql = (
	token: string,
	query: string,
	variables: Readonly<Record<string, unknown>>,
): Api<Attempt<Record<string, unknown>>> =>
	Effect.map(graphqlRead(token, query, variables), (outcome) => {
		if (outcome._tag === "Unreachable") return fail(outcome.reason);
		if (outcome.status < 200 || outcome.status >= 300) {
			return fail(`the GraphQL endpoint answered HTTP ${outcome.status}`);
		}
		if (!isRecord(outcome.body)) {
			return fail("the GraphQL endpoint answered 200 but its output is not a response");
		}
		const errors = outcome.body.errors;
		if (Array.isArray(errors) && errors.length > 0) {
			const said = errors
				.map((entry) => (isRecord(entry) ? str(entry.message) : ""))
				.filter((message) => message !== "")
				.join("; ");
			return fail(`the GraphQL endpoint refused: ${said === "" ? "no reason given" : said}`);
		}
		return isRecord(outcome.body.data)
			? ok(outcome.body.data)
			: fail("the GraphQL endpoint answered 200 but named no data");
	});

const PULL_ID_QUERY =
	"query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id}}}";

const ownerAndName = (repo: string): Attempt<{owner: string; name: string}> => {
	const [owner, name] = repo.split("/");
	return owner === undefined || name === undefined || owner === "" || name === ""
		? fail(`\`${repo}\` is not owner/name`)
		: ok({owner, name});
};

/** The PR's GraphQL node id — the one extra read both auto-merge mutations need. */
const pullRequestId = (token: string, repo: string, pr: number): Api<Attempt<string>> =>
	Effect.gen(function* () {
		const named = ownerAndName(repo);
		if (named._tag === "Failure") return named;
		const data = yield* graphql(token, PULL_ID_QUERY, {
			owner: named.value.owner,
			name: named.value.name,
			number: pr,
		});
		if (data._tag === "Failure") return data;
		const repository = isRecord(data.value.repository) ? data.value.repository : null;
		const pull =
			repository !== null && isRecord(repository.pullRequest) ? repository.pullRequest : null;
		const id = pull === null ? "" : str(pull.id);
		return id === "" ? fail(`the GraphQL endpoint named no node id for #${pr}`) : ok(id);
	});

const ARM_MUTATION =
	"mutation($pull:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$pull}){clientMutationId}}";

const DISARM_MUTATION =
	"mutation($pull:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$pull}){clientMutationId}}";

/**
 * Arm the queue's auto-merge at the verified head.
 *
 * **There is no merge method to pass, by construction.** The queue owns the method, and v1's
 * documented hazard is that a `--squash` alongside `--auto` conflicts with the queue and no-ops the
 * enqueue silently at exit 0. The mutation's own `mergeMethod` input is the same trap wearing the
 * GraphQL name, so it is left unset rather than defaulted.
 */
export const armAutoMerge = (repo: string, pr: number): Shell<Attempt<void>> =>
	authed((token) =>
		Effect.gen(function* () {
			const id = yield* pullRequestId(token, repo, pr);
			if (id._tag === "Failure") return id;
			const armed = yield* graphql(token, ARM_MUTATION, {pull: id.value});
			return armed._tag === "Failure" ? armed : ok(undefined);
		}),
	);

/** Clear a parked merge intent. Its exit status is never trusted — the caller re-reads. */
export const disableAutoMerge = (repo: string, pr: number): Shell<Attempt<void>> =>
	authed((token) =>
		Effect.gen(function* () {
			const id = yield* pullRequestId(token, repo, pr);
			if (id._tag === "Failure") return id;
			const cleared = yield* graphql(token, DISARM_MUTATION, {pull: id.value});
			return cleared._tag === "Failure" ? cleared : ok(undefined);
		}),
	);

/** Close or reopen a pull request. Each leg is read back by the caller; neither is trusted here. */
export const setPullState = (repo: string, pr: number, state: string): Shell<Attempt<void>> =>
	authed((token) =>
		Effect.map(
			deliver(
				HttpClientRequest.patch(endpoint(`repos/${repo}/pulls/${pr}`)).pipe(
					HttpClientRequest.setHeaders(headersFor(token, "application/vnd.github+json")),
					HttpClientRequest.bodyJsonUnsafe({state}),
				),
				(response) => response.text,
			),
			(outcome) => {
				if (outcome._tag === "Unreachable") return fail(outcome.reason);
				return outcome.status >= 200 && outcome.status < 300
					? ok(undefined)
					: fail(`GitHub answered HTTP ${outcome.status}`);
			},
		),
	);

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
	authed((token) =>
		Effect.gen(function* () {
			const named = ownerAndName(repo);
			if (named._tag === "Failure") return named;
			const threads: ReviewThread[] = [];
			let declared: number | null = null;
			let cursor: string | null = null;
			for (let page = 0; page < PAGE_CAP; page++) {
				const data = yield* graphql(token, THREADS_QUERY, {
					owner: named.value.owner,
					name: named.value.name,
					number: pr,
					...(cursor === null ? {} : {cursor}),
				});
				if (data._tag === "Failure") return data;
				const repository = isRecord(data.value.repository) ? data.value.repository : null;
				const pull =
					repository !== null && isRecord(repository.pullRequest) ? repository.pullRequest : null;
				const set = pull !== null && isRecord(pull.reviewThreads) ? pull.reviewThreads : null;
				if (set === null || !Array.isArray(set.nodes) || typeof set.totalCount !== "number") {
					return fail(
						"the GraphQL endpoint answered 200 but its output is not a review-thread page",
					);
				}
				declared ??= set.totalCount;
				for (const node of set.nodes) {
					const thread = threadOf(node);
					if (thread === null) {
						return fail("the GraphQL endpoint answered 200 but one node is not a thread");
					}
					threads.push(thread);
				}
				const info = isRecord(set.pageInfo) ? set.pageInfo : null;
				if (info === null || info.hasNextPage !== true) break;
				cursor = str(info.endCursor);
				if (cursor === "") {
					return fail("the GraphQL endpoint declared another page and named no cursor");
				}
			}
			return declared === null
				? fail("the GraphQL endpoint answered 200 and printed no thread page at all")
				: ok({declared, threads});
		}),
	);

const REPLY_MUTATION =
	"mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{url}}}";

const RESOLVE_MUTATION =
	"mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}";

/** Post the rationale reply. It lands **before** the resolve, so an interrupted run is never silent. */
export const replyToThread = (thread: string, body: string): Shell<Attempt<string>> =>
	authed((token) =>
		Effect.map(graphql(token, REPLY_MUTATION, {thread, body}), (data) => {
			if (data._tag === "Failure") return data;
			const added = isRecord(data.value.addPullRequestReviewThreadReply)
				? data.value.addPullRequestReviewThreadReply
				: null;
			const comment = added !== null && isRecord(added.comment) ? added.comment : null;
			return comment !== null && typeof comment.url === "string"
				? ok(comment.url)
				: fail("the GraphQL endpoint answered 200 but its output is not a posted reply");
		}),
	);

/** Fire the resolve. Its response is never the proof — the caller re-reads the thread. */
export const resolveThread = (thread: string): Shell<Attempt<void>> =>
	authed((token) =>
		Effect.map(graphql(token, RESOLVE_MUTATION, {thread}), (data) =>
			data._tag === "Failure" ? data : ok(undefined),
		),
	);
