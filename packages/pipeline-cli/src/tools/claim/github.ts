/**
 * The GitHub boundary for the `claim` verb: a read-only `Github` capability that
 * resolves "is this issue's claim mine?" over `gh api` REST, driving the IO-free
 * `claim-is-mine.ts` decision (which itself reuses epic-lock's `resolveClaim` core).
 *
 * Same `Context.Service`-on-`ChildProcessSpawner` shape as epic-lock's `github.ts`
 * (the epic #994 template child): REST only (GraphQL is broken on the kamp-us org),
 * every infra failure a typed error in the `E` channel (`.patterns/effect-errors.md`)
 * — a non-zero `gh` exit is `GhCommandError`, malformed output is `GhParseError`, an
 * unresolvable repo is `RepoResolutionError` — and Schema-decoded untrusted REST JSON
 * at the boundary. `isMine` and `status` only read; `release` deletes **only** comment ids the
 * pure `releasePlan` proved carry our own token, and `assign` writes **only** the coarse
 * availability gate (§7 layer one) on a lane whose claim resolved as ours. No claim write —
 * posting a claim stays `pipeline-cli tracker claim`'s job, so this tool never becomes a second
 * claim writer; layer one is a different layer, not a second claim.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {livenessByComment} from "../epic-lock/claim-presence.ts";
import type {ClaimComment} from "../epic-lock/claim-resolution.ts";
import {localPresence} from "../epic-lock/presence-io.ts";
import {deleteCommentArgs} from "../tracker/gh-io.ts";
import {type AssignPlan, assignPlan} from "./claim-assign.ts";
import {
	type AuditPolicy,
	type AuditReport,
	auditReport,
	type LaneInput,
	type LockedLane,
} from "./claim-audit.ts";
import {type ClaimVerdict, claimIsMine} from "./claim-is-mine.ts";
import {type ReleasePlan, releasePlan} from "./claim-release.ts";
import {type ClaimStatus, claimStatus} from "./claim-status.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/claim/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/claim/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/**
 * An `assign` wrote layer one and the read-back did not carry our login. The read-back folds INTO
 * the write so a caller can never report the availability gate set when it is not — that false
 * report is the whole failure this verb exists to end (#4298), so it fails loud instead.
 */
export class ClaimVerifyError extends Schema.TaggedErrorClass<ClaimVerifyError>()(
	"@kampus/claim/ClaimVerifyError",
	{
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/claim/RepoResolutionError",
	{
		message: Schema.String,
	},
) {}

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

/**
 * Run `gh <args>` and return stdout, failing `GhCommandError` on a non-zero exit.
 * `ChildProcess.make` is spawned directly to read `exitCode` + `stderr` and lower a
 * non-zero exit into a typed error; a spawn/IO `PlatformError` (e.g. `gh` not on
 * PATH) folds into the same `GhCommandError` (exit code `-1`).
 */
const runGh = Effect.fn("Github.runGh")(
	function* (args: ReadonlyArray<string>) {
		const handle = yield* ChildProcess.make("gh", args);
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[collect(handle.stdout), collect(handle.stderr), handle.exitCode],
			{concurrency: "unbounded"},
		);
		if (exitCode !== 0) {
			return yield* new GhCommandError({args, exitCode, stderr});
		}
		return stdout;
	},
	Effect.scoped,
	(effect, args) =>
		Effect.catchTag(
			effect,
			"PlatformError",
			(cause) => new GhCommandError({args, exitCode: -1, stderr: cause.message}),
		),
);

const parseJson = (
	args: ReadonlyArray<string>,
	raw: string,
): Effect.Effect<unknown, GhParseError> =>
	Effect.try({
		try: () => JSON.parse(raw) as unknown,
		catch: (cause) =>
			new GhParseError({args, message: cause instanceof Error ? cause.message : String(cause)}),
	});

const json = Effect.fn("Github.json")(function* (args: ReadonlyArray<string>) {
	return yield* parseJson(args, yield* runGh(args));
});

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * Resolve the target repo (`owner/name`) once, per ADR 0062 §1, in order:
 * `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` (CI) → `gh repo view`. Never silently
 * defaults: with no env and no resolvable current repo it fails `RepoResolutionError`.
 */
const resolveRepo = Effect.fn("Github.resolveRepo")(function* () {
	const fromEnv = process.env.CLAUDE_PIPELINE_REPO ?? process.env.GITHUB_REPOSITORY;
	if (fromEnv && REPO_RE.test(fromEnv.trim())) {
		return fromEnv.trim();
	}
	const viewed = yield* runGh([
		"repo",
		"view",
		"--json",
		"nameWithOwner",
		"-q",
		".nameWithOwner",
	]).pipe(
		Effect.map((out) => out.trim()),
		Effect.catchTag("@kampus/claim/GhCommandError", () => Effect.succeed("")),
	);
	if (REPO_RE.test(viewed)) {
		return viewed;
	}
	return yield* new RepoResolutionError({
		message:
			"could not resolve a target repo: set CLAUDE_PIPELINE_REPO (or GITHUB_REPOSITORY), " +
			"or run inside a git repo whose origin `gh repo view` can read",
	});
});

// REST-only arg builders — never GraphQL.

const listCommentsArgs = (repo: string, issue: number): ReadonlyArray<string> => [
	"api",
	"--paginate",
	`repos/${repo}/issues/${issue}/comments?per_page=100`,
];

const issueArgs = (repo: string, issue: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/issues/${issue}`,
];

// Layer one is written with the additive assignees endpoint — it co-assigns and never displaces,
// which is precisely why it is a coarse availability gate and not a claim (§7). There is no
// DELETE counterpart anywhere in this tool.
const addAssigneeArgs = (repo: string, issue: number, login: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"POST",
	`repos/${repo}/issues/${issue}/assignees`,
	"-f",
	`assignees[]=${login}`,
];

const whoAmIArgs: ReadonlyArray<string> = ["api", "user", "--jq", ".login"];

const permissionArgs = (repo: string, login: string): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/collaborators/${login}/permission`,
	"--jq",
	".permission",
];

/** A raw comment as the issues/comments endpoint returns it; only these fields are read. */
const RawComment = Schema.Struct({
	id: Schema.Number,
	created_at: Schema.String,
	body: Schema.optionalKey(Schema.NullOr(Schema.String)),
	user: Schema.NullOr(Schema.Struct({login: Schema.String})),
});
const decodeComments = Schema.decodeUnknownEffect(Schema.Array(RawComment));

const toClaimComment = (raw: (typeof RawComment)["Type"]): ClaimComment => ({
	id: raw.id,
	author: raw.user?.login ?? "",
	createdAt: raw.created_at,
	body: raw.body ?? "",
});

const listClaimComments = Effect.fn("Github.listClaimComments")(function* (
	repo: string,
	issue: number,
) {
	const raw = yield* decodeComments(yield* json(listCommentsArgs(repo, issue)));
	return raw.map(toClaimComment);
});

/**
 * The write+ collaborator subset of `logins` — the ADR 0055 trust root. Each login is
 * probed with `collaborators/<login>/permission`; a non-`admin|maintain|write`
 * permission, or any `gh` fault on the probe (a non-collaborator commonly 404s),
 * drops the login. A forged claim from a non-collaborator therefore never enters the
 * authorized set the decision resolves over.
 */
const authorizedAuthors = Effect.fn("Github.authorizedAuthors")(function* (
	repo: string,
	logins: ReadonlyArray<string>,
) {
	const results = yield* Effect.forEach(
		logins,
		(login) =>
			runGh(permissionArgs(repo, login)).pipe(
				Effect.map((out) => ({login, permission: out.trim()})),
				Effect.catchTag("@kampus/claim/GhCommandError", () =>
					Effect.succeed({login, permission: "none"}),
				),
			),
		{concurrency: "unbounded"},
	);
	return results
		.filter(
			(r) => r.permission === "admin" || r.permission === "maintain" || r.permission === "write",
		)
		.map((r) => r.login);
});

/**
 * Resolve whether the earliest authorized claim on `issue` is ours, default-deny.
 * Lists the issue's comments, resolves the write+ authorized-author set from the
 * distinct claim-marker authors, then hands both plus our session id to the pure
 * `claimIsMine` decision. Every un-resolvable state (no authorized claim, foreign
 * owner, missing session) answers not-mine — the fail-safe the decision guarantees.
 */
const isMine = Effect.fn("Github.isMine")(function* (
	repo: string,
	issue: number,
	sessionId: string | null,
) {
	const comments = yield* listClaimComments(repo, issue);
	const authors = [...new Set(comments.map((c) => c.author).filter((a) => a.length > 0))];
	const authorized = yield* authorizedAuthors(repo, authors);
	// ADR 0191 presence liveness (#3751): a claim whose stamped session process is provably gone
	// on THIS host is superseded, so a legitimate re-claim on an abandoned lane can resolve as
	// mine. Every indeterminate claimant (unstamped, another host, unprobeable pid) still counts.
	const liveness = livenessByComment(comments, localPresence());
	return claimIsMine({comments, authorizedAuthors: authorized, sessionId, liveness});
});

/** An issue as the issues endpoint returns it; only the availability gate is read. */
const RawAssignedIssue = Schema.Struct({
	assignees: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({login: Schema.String})))),
});
const decodeAssignedIssue = Schema.decodeUnknownEffect(RawAssignedIssue);

const assigneeLogins = Effect.fn("Github.assigneeLogins")(function* (args: ReadonlyArray<string>) {
	const issue = yield* decodeAssignedIssue(yield* json(args));
	return (issue.assignees ?? []).map((a) => a.login);
});

/** What an assign resolved to, and the availability gate as it stands after the verb ran. */
export interface AssignResult {
	readonly plan: AssignPlan;
	readonly assignees: ReadonlyArray<string>;
}

/**
 * Write §7 layer one — the coarse availability gate — on a lane whose claim is ours (#4298).
 *
 * Ownership is resolved through the same default-deny `isMine` the mis-attribution guard uses, and
 * a refusal short-circuits **before any read of the gate**: an un-owned lane is never even measured,
 * let alone written. On a proven-own lane the write is additive and idempotent (the pure
 * `assignPlan` decides), and the POST's response is decoded as the read-back — a landed gate that
 * does not carry our login raises `ClaimVerifyError` rather than reporting a gate that isn't there.
 */
const assign = Effect.fn("Github.assign")(function* (
	repo: string,
	issue: number,
	sessionId: string | null,
) {
	const verdict = yield* isMine(repo, issue, sessionId);
	if (!verdict.mine) {
		return {
			plan: assignPlan({verdict, login: "", assignees: []}),
			assignees: [],
		} satisfies AssignResult;
	}
	const login = yield* runGh(whoAmIArgs).pipe(
		Effect.map((out) => out.trim()),
		Effect.catchTag("@kampus/claim/GhCommandError", () => Effect.succeed("")),
	);
	const before = yield* assigneeLogins(issueArgs(repo, issue));
	const plan = assignPlan({verdict, login, assignees: before});
	if (plan._tag !== "assign") {
		return {plan, assignees: before} satisfies AssignResult;
	}
	const landed = yield* assigneeLogins(addAssigneeArgs(repo, issue, plan.login));
	if (!landed.some((a) => a.toLowerCase() === plan.login.toLowerCase())) {
		return yield* new ClaimVerifyError({
			message: `assigned #${issue} to ${plan.login} but the gate read back as [${landed.join(", ") || "empty"}] — refusing to report layer one set when it is not (#4298)`,
		});
	}
	return {plan, assignees: landed} satisfies AssignResult;
});

/** A clean 404 — the only `gh` failure that means "the comment is already gone". */
const is404 = (stderr: string): boolean => /404|not found/i.test(stderr);

/**
 * Retract our own claim on `issue` — the affirmative end of a run's claim (#3780). The pure
 * `releasePlan` decides the set; this only executes the DELETEs, so the invariant that release
 * never touches another session's marker is a property of the tested core, not of this loop.
 * A DELETE that 404s is benign (already retracted, idempotent re-release); any other fault is
 * LOUD — a silently-swallowed DELETE leaves the claim standing while the caller believes the
 * lane is free, which is the stall this verb exists to end.
 */
const release = Effect.fn("Github.release")(function* (
	repo: string,
	issue: number,
	sessionId: string,
) {
	const comments = yield* listClaimComments(repo, issue);
	const plan = releasePlan(comments, sessionId);
	yield* Effect.forEach(
		plan.retract,
		(id) =>
			runGh(deleteCommentArgs(repo, id)).pipe(
				Effect.catchTag("@kampus/claim/GhCommandError", (error) =>
					is404(error.stderr) ? Effect.void : Effect.fail(error),
				),
			),
		{concurrency: "unbounded", discard: true},
	);
	return plan;
});

/**
 * The read-only claim inventory of `issue` — every marker, its authorization, its ADR-0191
 * liveness, and which one owns the lane. The operational surface for a stale claim that no
 * release ever retracted (a crashed run, a pre-release-era marker): it makes the claim visible
 * so a human can clear it, and evicts nothing on its own.
 */
const status = Effect.fn("Github.status")(function* (repo: string, issue: number) {
	const comments = yield* listClaimComments(repo, issue);
	const authors = [...new Set(comments.map((c) => c.author).filter((a) => a.length > 0))];
	const authorized = yield* authorizedAuthors(repo, authors);
	const liveness = livenessByComment(comments, localPresence());
	return claimStatus({comments, authorizedAuthors: authorized, liveness});
});

/** An open-issue row; `pull_request` is how the issues endpoint marks the PRs it also returns. */
const RawIssue = Schema.Struct({
	number: Schema.Number,
	comments: Schema.optionalKey(Schema.Number),
	pull_request: Schema.optionalKey(Schema.Unknown),
});
const decodeIssues = Schema.decodeUnknownEffect(Schema.Array(RawIssue));

const listOpenIssuesArgs = (repo: string): ReadonlyArray<string> => [
	"api",
	"--paginate",
	`repos/${repo}/issues?state=open&per_page=100`,
];

/**
 * The open issues that could carry a claim: PRs dropped (a claim lives on the issue), and so are
 * issues with zero comments — a marker IS a comment, so that filter removes ~60% of the per-issue
 * comment reads without changing the result.
 */
const auditScope = Effect.fn("Github.auditScope")(function* (repo: string) {
	const rows = yield* decodeIssues(yield* json(listOpenIssuesArgs(repo)));
	return rows
		.filter((row) => row.pull_request === undefined && (row.comments ?? 0) > 0)
		.map((row) => row.number);
});

/** How many issues' comments are read at once — bounded so a full scan can't burst the API. */
const AUDIT_CONCURRENCY = 8;

/**
 * Audit the open lanes for pre-stamping claim holders, and — when `execute` is set — retire the
 * ones the pure policy proved retirable.
 *
 * Two things are deliberate. The write+ author set and this machine's presence are each resolved
 * **once** for the whole scan rather than per lane: the author probe is one REST call per distinct
 * login, and `localPresence()` spawns `ioreg`/`ps`, so per-lane resolution would turn a hundred-lane
 * scan into hundreds of subprocesses. And retirement calls the same `release` the `claim release`
 * verb calls, under the marker's own token — one retraction mechanism, never a second (#3780).
 */
const audit = Effect.fn("Github.audit")(function* (
	repo: string,
	options: {
		readonly issues: ReadonlyArray<number> | null;
		readonly policy: AuditPolicy;
		readonly execute: boolean;
	},
) {
	const issues = options.issues ?? (yield* auditScope(repo));
	const commentsByIssue = yield* Effect.forEach(
		issues,
		(issue) => listClaimComments(repo, issue).pipe(Effect.map((comments) => ({issue, comments}))),
		{concurrency: AUDIT_CONCURRENCY},
	);
	const authors = [
		...new Set(
			commentsByIssue
				.flatMap((lane) => lane.comments.map((c) => c.author))
				.filter((a) => a.length > 0),
		),
	];
	const authorized = yield* authorizedAuthors(repo, authors);
	const local = localPresence();
	const inputs = commentsByIssue.map(
		(lane): LaneInput => ({
			issue: lane.issue,
			comments: lane.comments,
			authorizedAuthors: authorized,
			liveness: livenessByComment(lane.comments, local),
		}),
	);
	const report = auditReport(inputs, options.policy);
	if (!options.execute) return {report, retired: [] as ReadonlyArray<LockedLane>};
	yield* Effect.forEach(report.retirable, (lane) => release(repo, lane.issue, lane.owner.session), {
		concurrency: AUDIT_CONCURRENCY,
		discard: true,
	});
	return {report, retired: report.retirable};
});

/** What an audit run produced: the blast-radius report, and the lanes retirement actually took. */
export interface AuditResult {
	readonly report: AuditReport;
	readonly retired: ReadonlyArray<LockedLane>;
}

/**
 * `Github` — the IO shell over `gh api` REST behind the three `claim` verbs: `isMine`
 * (the default-deny `ClaimVerdict`), `release` (retract our own marker when the run is
 * done), and `status` (the read-only claim inventory). Built by `GithubLive`, whose `R` is
 * `ChildProcessSpawner`: provide the platform spawner (`NodeServices.layer`) in
 * production; a test provides a mock spawner via `ChildProcessSpawner.make`.
 */
export class Github extends Context.Service<
	Github,
	{
		readonly isMine: (
			issue: number,
			sessionId: string | null,
		) => Effect.Effect<
			ClaimVerdict,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
		readonly release: (
			issue: number,
			sessionId: string,
		) => Effect.Effect<
			ReleasePlan,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
		readonly assign: (
			issue: number,
			sessionId: string | null,
		) => Effect.Effect<
			AssignResult,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError | ClaimVerifyError
		>;
		readonly status: (
			issue: number,
		) => Effect.Effect<
			ClaimStatus,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
		readonly audit: (options: {
			readonly issues: ReadonlyArray<number> | null;
			readonly policy: AuditPolicy;
			readonly execute: boolean;
		}) => Effect.Effect<
			AuditResult,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
	}
>()("@kampus/claim/Github") {}

/**
 * The live `Github` layer. The `ChildProcessSpawner` dependency is captured once at
 * construction and provided *into* the method body, so the public method carries
 * `R = never`. Repo resolution is deferred to first use (`Effect.cached`, ADR 0062
 * §1): the layer build is side-effect-free, and `RepoResolutionError` lives in the
 * method's `E` channel, raised only when `isMine` actually reads.
 */
export const GithubLive: Layer.Layer<Github, never, ChildProcessSpawner.ChildProcessSpawner> =
	Layer.effect(Github)(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const withSpawner = <A, E>(
				effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
			) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
			const repo = yield* Effect.cached(withSpawner(resolveRepo()));
			return {
				isMine: (issue: number, sessionId: string | null) =>
					repo.pipe(Effect.flatMap((r) => withSpawner(isMine(r, issue, sessionId)))),
				release: (issue: number, sessionId: string) =>
					repo.pipe(Effect.flatMap((r) => withSpawner(release(r, issue, sessionId)))),
				assign: (issue: number, sessionId: string | null) =>
					repo.pipe(Effect.flatMap((r) => withSpawner(assign(r, issue, sessionId)))),
				status: (issue: number) => repo.pipe(Effect.flatMap((r) => withSpawner(status(r, issue)))),
				audit: (options) => repo.pipe(Effect.flatMap((r) => withSpawner(audit(r, options)))),
			};
		}),
	);
