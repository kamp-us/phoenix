/**
 * The GitHub boundary for `split-guard` (#3464): the live `Github` capability that reads the
 * open `status:needs-triage` queue — WITH bodies — over `gh api` REST, feeding the IO-free
 * `split-match.ts` core.
 *
 * Why the needs-triage queue and not the search index: the double-fire the guard closes emits its
 * twin seconds apart (a retry/re-emit of the same split), so the read that catches it must be
 * read-after-write consistent. The issues LIST endpoint filtered by `status:needs-triage` is — a
 * child created seconds ago is already visible there — whereas `search/issues` is eventually
 * consistent and would miss the just-created twin. Split children are always created
 * `status:needs-triage` (triage Step 3.3), so the queue is exactly where a fresh twin lives.
 *
 * Same service pattern as `intake-dedup` / `verdict` (epic #994): a `Context.Service` on
 * `ChildProcessSpawner`, REST only (GraphQL is broken on the kamp-us org), every infra failure a
 * typed error in the `E` channel, untrusted REST JSON Schema-decoded at the boundary.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import type {ChildRef} from "./split-match.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/split-guard/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/split-guard/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/split-guard/RepoResolutionError",
	{
		message: Schema.String,
	},
) {}

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

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
 * `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` (CI) → `gh repo view`. Never silently defaults.
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
		Effect.catchTag("@kampus/split-guard/GhCommandError", () => Effect.succeed("")),
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

// REST-only arg builder — never GraphQL. Paginated so a queue past one page is fully read.
const queueArgs = (repo: string, label: string): ReadonlyArray<string> => [
	"api",
	"--paginate",
	`repos/${repo}/issues?state=open&labels=${label}&per_page=100`,
];

/**
 * A raw issue row from the issues endpoint. `pull_request` present ⇒ it is a PR (the endpoint
 * returns both) and never a split child, so it's dropped. `body` is nullable on the REST surface.
 */
const RawIssue = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	body: Schema.NullOr(Schema.String),
	pull_request: Schema.optionalKey(Schema.Unknown),
});
const decodeQueue = Schema.decodeUnknownEffect(Schema.Array(RawIssue));

const queue = Effect.fn("Github.queue")(function* (repo: string, label: string) {
	const args = queueArgs(repo, label);
	const rows = yield* decodeQueue(yield* json(args));
	return rows
		.filter((r) => r.pull_request === undefined)
		.map((r): ChildRef => ({number: r.number, title: r.title, body: r.body ?? ""}));
});

/**
 * `Github` — the IO shell over `gh api` REST. `queue(label)` lists the open `needs-triage`
 * queue (read-after-write consistent) with bodies, which the core scans for the `split from
 * #<parent>` back-reference. Built by `GithubLive`, whose `R` is `ChildProcessSpawner`.
 */
export class Github extends Context.Service<
	Github,
	{
		readonly queue: (
			label: string,
		) => Effect.Effect<
			ReadonlyArray<ChildRef>,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
	}
>()("@kampus/split-guard/Github") {}

/**
 * The live `Github` layer. The `ChildProcessSpawner` dependency is captured once at construction
 * and provided into each method body, so the public method carries `R = never`. Repo resolution is
 * deferred to first use (`Effect.cached`, ADR 0062 §1): the layer build is side-effect-free.
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
			};
		}),
	);
