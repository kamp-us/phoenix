/**
 * The GitHub boundary: read the set of OPEN PR numbers, so the sweep keeps each open
 * PR's `pr-<n>` preview stage. Shells `gh api` REST over `ChildProcessSpawner` — REST
 * only (GraphQL is broken on the kamp-us org), the same boundary shape as
 * `@kampus/flake-rate`'s `github.ts`. Read-only; the repo is resolved per ADR 0062 §1.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";

const OpenPullsResponse = Schema.Array(Schema.Struct({number: Schema.Number}));
const decodePulls = Schema.decodeUnknownEffect(OpenPullsResponse);

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/orphan-sweep/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/orphan-sweep/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/orphan-sweep/RepoResolutionError",
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

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/** Resolve the target repo (`owner/name`) once, per ADR 0062 §1. Never silently defaults. */
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
		Effect.catchTag("@kampus/orphan-sweep/GhCommandError", () => Effect.succeed("")),
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

/**
 * `Github` — reads the OPEN PR numbers (the `pr-<n>` previews the sweep must keep).
 * Built by `GithubLive`, whose `R` is `ChildProcessSpawner`. Read-only.
 */
export class Github extends Context.Service<
	Github,
	{
		readonly openPrNumbers: () => Effect.Effect<
			ReadonlyArray<number>,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
	}
>()("@kampus/orphan-sweep/Github") {}

const loadOpenPrs = Effect.fn("Github.openPrNumbers")(function* (repo: string) {
	// `--paginate` walks every page so a busy repo's open PRs aren't capped at the
	// default 30 — a missed open PR would let its still-live preview be swept.
	const args = ["api", "--paginate", `repos/${repo}/pulls?state=open&per_page=100`];
	const raw = yield* runGh(args);
	const decoded = yield* decodePulls(yield* parseJson(args, normalizePaginatedJson(raw)));
	return decoded.map((p) => p.number);
});

/**
 * `gh api --paginate` concatenates each page's JSON array with no separator
 * (`][` between pages). Splice those into one array so a multi-page result decodes as a
 * single `[…]`. A single page passes through untouched.
 */
const normalizePaginatedJson = (raw: string): string => raw.replaceAll("][", ",");

/**
 * The live `Github` layer. Mirrors `@kampus/flake-rate`'s `GithubLive`: spawner captured
 * at construction, repo resolution `Effect.cached` and deferred to first use.
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
				openPrNumbers: () => repo.pipe(Effect.flatMap((r) => withSpawner(loadOpenPrs(r)))),
			};
		}),
	);
