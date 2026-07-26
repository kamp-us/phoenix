/**
 * The GitHub boundary for `lane`: the read-only `LaneSources` capability that scans the open
 * issues (with their ADR-0115 claim owners) and the open PRs over `gh api` REST, so the pure
 * core can compute the lane set from artifacts anyone can re-read.
 *
 * Same `Context.Service`-on-`ChildProcessSpawner` shape as `claim`/`homing-guard` (epic #994):
 * REST only (GraphQL is broken on the kamp-us org), every infra failure a typed error in the
 * `E` channel, untrusted REST JSON Schema-decoded at the boundary.
 *
 * Claim ownership is resolved through the shared ADR-0115 resolver (`resolveWinner` +
 * the write+ author gate of ADR 0055 + ADR-0191 presence liveness) — this tool never
 * re-derives claim resolution, and it never writes a claim.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {livenessByComment} from "../epic-lock/claim-presence.ts";
import type {ClaimComment} from "../epic-lock/claim-resolution.ts";
import {resolveWinner} from "../epic-lock/claim-resolution.ts";
import {localPresence} from "../epic-lock/presence-io.ts";
import {type LaneInventory, type LaneIssue, type LanePr, parseCloses} from "./lane.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/lane/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/lane/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/lane/RepoResolutionError",
	{
		message: Schema.String,
	},
) {}

export type LaneReadError =
	| RepoResolutionError
	| GhCommandError
	| GhParseError
	| Schema.SchemaError;

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

const runGh = Effect.fn("LaneSources.runGh")(
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

const json = Effect.fn("LaneSources.json")(function* (args: ReadonlyArray<string>) {
	const raw = yield* runGh(args);
	return yield* Effect.try({
		try: () => JSON.parse(raw) as unknown,
		catch: (cause) =>
			new GhParseError({args, message: cause instanceof Error ? cause.message : String(cause)}),
	});
});

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * Resolve the target repo (`owner/name`) once, per ADR 0062 §1, in order:
 * `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` (CI) → `gh repo view`. Never silently defaults.
 */
const resolveRepo = Effect.fn("LaneSources.resolveRepo")(function* () {
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
		Effect.catchTag("@kampus/lane/GhCommandError", () => Effect.succeed("")),
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

// `--slurp` because bare `--paginate` concatenates one JSON array per page, which is
// unparseable as a whole past 100 rows (#3762); it wraps the pages in an array instead.
const openIssuesArgs = (repo: string): ReadonlyArray<string> => [
	"api",
	"--paginate",
	"--slurp",
	`repos/${repo}/issues?state=open&per_page=100`,
];

const openPullsArgs = (repo: string): ReadonlyArray<string> => [
	"api",
	"--paginate",
	"--slurp",
	`repos/${repo}/pulls?state=open&per_page=100`,
];

const commentsArgs = (repo: string, issue: number): ReadonlyArray<string> => [
	"api",
	"--paginate",
	"--slurp",
	`repos/${repo}/issues/${issue}/comments?per_page=100`,
];

const permissionArgs = (repo: string, login: string): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/collaborators/${login}/permission`,
	"--jq",
	".permission",
];

/** An open-issue row; `pull_request` is how the issues endpoint marks the PRs it also returns. */
const RawIssue = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	labels: Schema.Array(Schema.Struct({name: Schema.String})),
	comments: Schema.optionalKey(Schema.Number),
	pull_request: Schema.optionalKey(Schema.Unknown),
});

const RawPull = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	body: Schema.optionalKey(Schema.NullOr(Schema.String)),
	draft: Schema.optionalKey(Schema.Boolean),
});

const RawComment = Schema.Struct({
	id: Schema.Number,
	created_at: Schema.String,
	body: Schema.optionalKey(Schema.NullOr(Schema.String)),
	user: Schema.NullOr(Schema.Struct({login: Schema.String})),
});

const decodeIssuePages = Schema.decodeUnknownEffect(Schema.Array(Schema.Array(RawIssue)));
const decodePullPages = Schema.decodeUnknownEffect(Schema.Array(Schema.Array(RawPull)));
const decodeCommentPages = Schema.decodeUnknownEffect(Schema.Array(Schema.Array(RawComment)));

const toClaimComment = (raw: (typeof RawComment)["Type"]): ClaimComment => ({
	id: raw.id,
	author: raw.user?.login ?? "",
	createdAt: raw.created_at,
	body: raw.body ?? "",
});

/**
 * The write+ collaborator subset of `logins` — the ADR 0055 trust root. A non-`write+`
 * permission, or any `gh` fault on the probe (a non-collaborator commonly 404s), drops the
 * login, so a forged claim marker never resolves as a lane holder.
 */
const authorizedAuthors = Effect.fn("LaneSources.authorizedAuthors")(function* (
	repo: string,
	logins: ReadonlyArray<string>,
) {
	const results = yield* Effect.forEach(
		logins,
		(login) =>
			runGh(permissionArgs(repo, login)).pipe(
				Effect.map((out) => ({login, permission: out.trim()})),
				Effect.catchTag("@kampus/lane/GhCommandError", () =>
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

/** How many issues' comments are read at once — bounded so a full scan can't burst the API. */
const SCAN_CONCURRENCY = 8;

const listComments = Effect.fn("LaneSources.listComments")(function* (repo: string, issue: number) {
	const pages = yield* decodeCommentPages(yield* json(commentsArgs(repo, issue)));
	return pages.flat().map(toClaimComment);
});

/**
 * Scan the open issues and resolve each one's claim owner.
 *
 * An issue with zero comments is skipped before its comment read: a claim marker IS a comment,
 * so the filter removes most of the per-issue reads without changing any holder. The claim, not
 * the GitHub assignee, is what proves occupancy — the assignee is a login-blind coarse gate
 * (ADR 0115 §1) that the orchestrated path may not have set yet, so keying on it would miss a
 * live lane.
 */
const scanIssues = Effect.fn("LaneSources.scanIssues")(function* (repo: string) {
	const pages = yield* decodeIssuePages(yield* json(openIssuesArgs(repo)));
	const rows = pages.flat().filter((row) => row.pull_request === undefined);
	const candidates = rows.filter((row) => (row.comments ?? 0) > 0);
	const commentsByIssue = yield* Effect.forEach(
		candidates,
		(row) =>
			listComments(repo, row.number).pipe(
				Effect.map((comments) => ({issue: row.number, comments})),
			),
		{concurrency: SCAN_CONCURRENCY},
	);
	const authors = [
		...new Set(
			commentsByIssue.flatMap((lane) => lane.comments.map((c) => c.author)).filter((a) => a !== ""),
		),
	];
	// Resolved ONCE for the whole scan: the author probe is a REST call per distinct login and
	// `localPresence()` spawns process-table probes, so per-issue resolution would turn a
	// hundred-issue scan into hundreds of subprocesses (the same budget `claim audit` keeps).
	const authorized = yield* authorizedAuthors(repo, authors);
	const local = localPresence();
	const holders = new Map(
		commentsByIssue.map((lane) => [
			lane.issue,
			resolveWinner(lane.comments, authorized, livenessByComment(lane.comments, local))?.session ??
				null,
		]),
	);
	return rows.map(
		(row): LaneIssue => ({
			number: row.number,
			title: row.title,
			labels: row.labels.map((label) => label.name),
			holder: holders.get(row.number) ?? null,
		}),
	);
});

const scanPulls = Effect.fn("LaneSources.scanPulls")(function* (repo: string) {
	const pages = yield* decodePullPages(yield* json(openPullsArgs(repo)));
	return pages.flat().map(
		(row): LanePr => ({
			number: row.number,
			title: row.title,
			closes: parseCloses(row.body ?? ""),
			draft: row.draft ?? false,
		}),
	);
});

/**
 * `LaneSources` — the IO shell over `gh api` REST for `lane`. `inventory` reads the open issues
 * (with claim owners) and the open PRs, which is everything the pure core needs. Built by
 * `LaneSourcesLive`, whose `R` is `ChildProcessSpawner`.
 */
export class LaneSources extends Context.Service<
	LaneSources,
	{
		readonly inventory: () => Effect.Effect<LaneInventory, LaneReadError>;
	}
>()("@kampus/lane/LaneSources") {}

/**
 * The live `LaneSources` layer. Repo resolution is deferred to first use (`Effect.cached`, ADR
 * 0062 §1), so the layer build is side-effect-free and `RepoResolutionError` lives in the
 * method's `E` channel.
 */
export const LaneSourcesLive: Layer.Layer<
	LaneSources,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(LaneSources)(
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const withSpawner = <A, E>(
			effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
		) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
		const repo = yield* Effect.cached(withSpawner(resolveRepo()));
		return {
			inventory: () =>
				repo.pipe(
					Effect.flatMap((r) =>
						Effect.all(
							{issues: withSpawner(scanIssues(r)), prs: withSpawner(scanPulls(r))},
							{concurrency: 2},
						),
					),
				),
		};
	}),
);
