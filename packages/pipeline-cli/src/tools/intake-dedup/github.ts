/**
 * The GitHub boundary for `intake-dedup`: the live `Github` capability that fetches the two
 * intake-dedup result sources over `gh api` REST, feeding the IO-free `dedup-match.ts` core.
 *
 * Same service pattern as the `verdict` / `epic-lock` template children (epic #994): a
 * `Context.Service` on `ChildProcessSpawner`, REST only (GraphQL is broken on the kamp-us
 * org), every infra failure a typed error in the `E` channel, untrusted REST JSON
 * Schema-decoded at the boundary into `IssueRef`s the core ranks over.
 *
 * Two reads, mirroring the pair the report/triage skills hand-ran:
 *  - `queue(label)` — open issues carrying `label` (`status:needs-triage`), read-after-write
 *    consistent (catches an issue filed seconds ago); PR rows are dropped (the issues
 *    endpoint returns both, but a PR is never an intake duplicate).
 *  - `search(tokens)` — the `search/issues` index over the query the core builds; covers
 *    older open issues that have already left the needs-triage queue.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {type IssueRef, searchQuery} from "./dedup-match.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/intake-dedup/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/intake-dedup/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/intake-dedup/RepoResolutionError",
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
 * Run `gh <args>` and return stdout, failing `GhCommandError` on a non-zero exit — the same
 * direct-spawn shape `verdict`/`epic-lock` use so a non-zero exit + stderr lower into a typed
 * error rather than a throw. A spawn/IO `PlatformError` (e.g. `gh` not on PATH) folds in as exit `-1`.
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
 * `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` (CI) → `gh repo view`. Never silently defaults —
 * with no env and no resolvable current repo it fails `RepoResolutionError`.
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
		Effect.catchTag("@kampus/intake-dedup/GhCommandError", () => Effect.succeed("")),
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

const queueArgs = (repo: string, label: string): ReadonlyArray<string> => [
	"api",
	"--paginate",
	`repos/${repo}/issues?state=open&labels=${label}&per_page=100`,
];

const searchArgs = (query: string): ReadonlyArray<string> => [
	"api",
	"--method",
	"GET",
	"search/issues",
	"-f",
	`q=${query}`,
	"-F",
	"per_page=100",
];

/**
 * A raw issue row from the issues endpoint; `pull_request` present ⇒ it is a PR, which the
 * issues endpoint returns alongside issues and which is never an intake duplicate — so it's dropped.
 */
const RawIssue = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	pull_request: Schema.optionalKey(Schema.Unknown),
});
const decodeQueue = Schema.decodeUnknownEffect(Schema.Array(RawIssue));

/** The `search/issues` envelope; only `items[].{number,title}` are read (PRs never match `is:issue`). */
const SearchResult = Schema.Struct({
	items: Schema.Array(Schema.Struct({number: Schema.Number, title: Schema.String})),
});
const decodeSearch = Schema.decodeUnknownEffect(SearchResult);

const queue = Effect.fn("Github.queue")(function* (repo: string, label: string) {
	const args = queueArgs(repo, label);
	const rows = yield* decodeQueue(yield* json(args));
	return rows
		.filter((r) => r.pull_request === undefined)
		.map((r): IssueRef => ({number: r.number, title: r.title}));
});

const search = Effect.fn("Github.search")(function* (repo: string, tokens: ReadonlyArray<string>) {
	const args = searchArgs(searchQuery(repo, tokens));
	const {items} = yield* decodeSearch(yield* json(args));
	return items.map((i): IssueRef => ({number: i.number, title: i.title}));
});

/**
 * `Github` — the IO shell over `gh api` REST for the two intake-dedup sources. `queue`
 * lists the `needs-triage` queue (read-after-write), `search` runs the built query against
 * the search index. Built by `GithubLive`, whose `R` is `ChildProcessSpawner`.
 */
export class Github extends Context.Service<
	Github,
	{
		readonly queue: (
			label: string,
		) => Effect.Effect<
			ReadonlyArray<IssueRef>,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
		readonly search: (
			tokens: ReadonlyArray<string>,
		) => Effect.Effect<
			ReadonlyArray<IssueRef>,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
	}
>()("@kampus/intake-dedup/Github") {}

/**
 * The live `Github` layer. The `ChildProcessSpawner` dependency is captured once at
 * construction and provided into each method body, so the public methods carry `R = never`.
 * Repo resolution is deferred to first use (`Effect.cached`, ADR 0062 §1): the layer build is
 * side-effect-free, and `RepoResolutionError` lives in each method's `E`, raised only on a real read.
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
				queue: (label) => repo.pipe(Effect.flatMap((r) => withSpawner(queue(r, label)))),
				search: (tokens) => repo.pipe(Effect.flatMap((r) => withSpawner(search(r, tokens)))),
			};
		}),
	);
