/**
 * The GitHub boundary for `unresolved-threads-guard`: the live `Github` capability that
 * gathers a PR's review threads + its latest authorized review-code verdict body, driving
 * the IO-free `unresolved-threads-guard.ts` core.
 *
 * Same `Context.Service` on `ChildProcessSpawner` shape as the `verdict` service (LLMS.md
 * §"Writing Effect services" / Context.Service): every infra failure a typed error in the
 * `E` channel (`GhCommandError` / `GhParseError` / `RepoResolutionError`), untrusted output
 * Schema-decoded at the boundary.
 *
 * REST for everything EXCEPT the one read ADR 0158 sanctions as the single GraphQL exception:
 * inline-thread RESOLUTION state (`isResolved`) is a GraphQL-only field — the REST
 * `pulls/{n}/comments` endpoint exposes the comments but has no `isResolved`, so it cannot
 * tell resolved from unresolved (ADR 0158; verified working on this org, the Projects-classic
 * breakage is scoped to Projects fields, not `reviewThreads`).
 *
 * One verb — `gather(pr)`:
 *   1. `reviewThreads` (GraphQL, the sanctioned exception) → the PR's threads with resolution state;
 *   2. the PR's issue comments (REST), author-gated to write+ collaborators (ADR 0055), latest
 *      `review-code:` marker by (created_at, id) → the verdict body the core checks accounting against.
 * A forged `review-code: PASS … path:line` marker from a non-collaborator can't spoof accounting:
 * the author-gate drops it before it can count.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {isReviewCodeVerdict, type ReviewThread} from "./unresolved-threads-guard.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, a GraphQL error, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/unresolved-threads-guard/GhCommandError",
	{args: Schema.Array(Schema.String), exitCode: Schema.Number, stderr: Schema.String},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/unresolved-threads-guard/GhParseError",
	{args: Schema.Array(Schema.String), message: Schema.String},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/unresolved-threads-guard/RepoResolutionError",
	{message: Schema.String},
) {}

/** The gathered facts the pure core judges: the PR's threads + its latest authorized verdict body. */
export interface GatherResult {
	readonly threads: ReadonlyArray<ReviewThread>;
	readonly verdictBody: string | null;
}

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

/**
 * Run `gh <args>` and return stdout, failing `GhCommandError` on a non-zero exit — the
 * direct-spawn shape `verdict`/`epic-lock` use, so a non-zero exit + stderr lower into a
 * typed error rather than a throw (LLMS.md §"Working with child processes"). A spawn/IO
 * `PlatformError` (`gh` not on PATH) folds in as exit `-1`.
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
 * Resolve the target repo (`owner/name`) once, per ADR 0062 §1:
 * `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` (CI) → `gh repo view`. Never silently
 * defaults — with no env and no resolvable current repo it fails `RepoResolutionError`.
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
		Effect.catchTag("@kampus/unresolved-threads-guard/GhCommandError", () => Effect.succeed("")),
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

// The ONE GraphQL read the guard makes — ADR 0158's single sanctioned exception (REST has no
// isResolved). `first:100` matches Step 3e's read; a PR with >100 threads is far outside any
// real pipeline PR and would surface its first 100.
const REVIEW_THREADS_QUERY = `
	query($o:String!,$n:String!,$pr:Int!) {
		repository(owner:$o, name:$n) {
			pullRequest(number:$pr) {
				reviewThreads(first:100) {
					nodes {
						isResolved
						isOutdated
						path
						line
						comments(first:1) { nodes { author { login } body } }
					}
				}
			}
		}
	}`;

const reviewThreadsArgs = (owner: string, name: string, pr: number): ReadonlyArray<string> => [
	"api",
	"graphql",
	"-f",
	`query=${REVIEW_THREADS_QUERY}`,
	"-F",
	`o=${owner}`,
	"-F",
	`n=${name}`,
	"-F",
	`pr=${pr}`,
];

const listCommentsArgs = (repo: string, pr: number): ReadonlyArray<string> => [
	"api",
	"--paginate",
	`repos/${repo}/issues/${pr}/comments?per_page=100`,
];

const permissionArgs = (repo: string, login: string): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/collaborators/${login}/permission`,
	"--jq",
	".permission",
];

/** The GraphQL `reviewThreads` response shape — only the fields the guard reads. */
const RawThread = Schema.Struct({
	isResolved: Schema.Boolean,
	isOutdated: Schema.Boolean,
	path: Schema.NullOr(Schema.String),
	line: Schema.NullOr(Schema.Number),
	comments: Schema.Struct({
		nodes: Schema.Array(
			Schema.Struct({
				author: Schema.NullOr(Schema.Struct({login: Schema.String})),
				body: Schema.NullOr(Schema.String),
			}),
		),
	}),
});
const ReviewThreadsResponse = Schema.Struct({
	data: Schema.Struct({
		repository: Schema.Struct({
			pullRequest: Schema.Struct({
				reviewThreads: Schema.Struct({nodes: Schema.Array(RawThread)}),
			}),
		}),
	}),
});
const decodeThreads = Schema.decodeUnknownEffect(ReviewThreadsResponse);

/** A raw issue comment as the REST endpoint returns it; only these fields are read. */
const RawComment = Schema.Struct({
	id: Schema.Number,
	created_at: Schema.String,
	body: Schema.optionalKey(Schema.NullOr(Schema.String)),
	user: Schema.NullOr(Schema.Struct({login: Schema.String})),
});
const decodeComments = Schema.decodeUnknownEffect(Schema.Array(RawComment));

const EXCERPT_LEN = 200;

const toReviewThread = (raw: (typeof RawThread)["Type"]): ReviewThread => {
	const first = raw.comments.nodes[0];
	return {
		isResolved: raw.isResolved,
		isOutdated: raw.isOutdated,
		path: raw.path,
		line: raw.line,
		author: first?.author?.login ?? null,
		excerpt: (first?.body ?? "").slice(0, EXCERPT_LEN),
	};
};

const readThreads = Effect.fn("Github.readThreads")(function* (repo: string, pr: number) {
	const [owner, name] = repo.split("/");
	const args = reviewThreadsArgs(owner ?? "", name ?? "", pr);
	const decoded = yield* decodeThreads(yield* json(args));
	return decoded.data.repository.pullRequest.reviewThreads.nodes.map(toReviewThread);
});

/**
 * The write+ collaborator subset of `logins` — the ADR 0055 trust root. Each login is probed
 * with `collaborators/<login>/permission`; a non-`admin|maintain|write` permission, or any
 * `gh` fault (a non-collaborator commonly 404s), drops the login. A forged review-code marker
 * from a non-collaborator therefore never counts as accounting.
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
				Effect.catchTag("@kampus/unresolved-threads-guard/GhCommandError", () =>
					Effect.succeed({login, permission: "none"}),
				),
			),
		{concurrency: "unbounded"},
	);
	return new Set(
		results
			.filter(
				(r) => r.permission === "admin" || r.permission === "maintain" || r.permission === "write",
			)
			.map((r) => r.login),
	);
});

/**
 * Resolve the latest AUTHORIZED review-code verdict body on the PR, or null. Filter the PR's
 * comments to `review-code:` markers, author-gate the distinct authors to write+ collaborators
 * (ADR 0055), keep only authorized markers, take the newest by (created_at, id) — the same
 * latest-wins the verdict tool resolves with.
 */
const readVerdictBody = Effect.fn("Github.readVerdictBody")(function* (repo: string, pr: number) {
	const raw = yield* decodeComments(yield* json(listCommentsArgs(repo, pr)));
	const markers = raw
		.map((c) => ({
			id: c.id,
			createdAt: c.created_at,
			author: c.user?.login ?? "",
			body: c.body ?? "",
		}))
		.filter((c) => c.author.length > 0 && isReviewCodeVerdict(c.body));
	if (markers.length === 0) return null;
	const authors = [...new Set(markers.map((m) => m.author))];
	const authorized = yield* authorizedAuthors(repo, authors);
	const trusted = markers.filter((m) => authorized.has(m.author));
	if (trusted.length === 0) return null;
	trusted.sort((a, b) =>
		a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id,
	);
	return trusted[trusted.length - 1]?.body ?? null;
});

const gather = Effect.fn("Github.gather")(function* (repo: string, pr: number) {
	const [threads, verdictBody] = yield* Effect.all(
		[readThreads(repo, pr), readVerdictBody(repo, pr)],
		{concurrency: "unbounded"},
	);
	return {threads, verdictBody} satisfies GatherResult;
});

/**
 * `Github` — the IO shell over `gh` for the unresolved-threads gate. `gather(pr)` returns the
 * PR's review threads + its latest authorized review-code verdict body; the command runs the
 * pure `judge` over the result. Built by `GithubLive`, whose `R` is `ChildProcessSpawner`.
 */
export class Github extends Context.Service<
	Github,
	{
		readonly gather: (
			pr: number,
		) => Effect.Effect<
			GatherResult,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
	}
>()("@kampus/unresolved-threads-guard/Github") {}

/**
 * The live `Github` layer. The `ChildProcessSpawner` dependency is captured once and
 * provided into the method body, so the public method carries `R = never`. Repo resolution
 * is deferred to first use (`Effect.cached`, ADR 0062 §1): the layer build is side-effect
 * free, and `RepoResolutionError` lives in the method's `E` channel.
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
				gather: (pr) => repo.pipe(Effect.flatMap((r) => withSpawner(gather(r, pr)))),
			};
		}),
	);
