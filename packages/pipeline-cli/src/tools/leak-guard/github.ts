/**
 * The `gh api` REST boundary for `leak-guard scan-pr`: fetch a PR's landed comments — both the
 * issue conversation (where `review-*` verdict markers live) AND the inline review comments — so the
 * pure `scanPrComments` core can re-check them for machine-local path leaks. REST only (GraphQL is
 * broken on the kamp-us org); untrusted REST JSON is Schema-decoded at the boundary into the domain
 * `PrComment` the core scans. See issue #3019.
 *
 * Same service shape as `verdict`'s `Github` (a `Context.Service` on `ChildProcessSpawner`, repo
 * resolved once per ADR 0062 §1, every infra fault a typed error) — a deliberately separate, minimal
 * boundary: this tool only READS the two comment endpoints, it never posts.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import type {PrComment} from "./scan-pr.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/leak-guard/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/leak-guard/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/leak-guard/RepoResolutionError",
	{
		message: Schema.String,
	},
) {}

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

const runGh = Effect.fn("LeakGuardGithub.runGh")(
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

const json = Effect.fn("LeakGuardGithub.json")(function* (args: ReadonlyArray<string>) {
	return yield* parseJson(args, yield* runGh(args));
});

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/** Resolve the target repo (`owner/name`) per ADR 0062 §1: env override → CI env → `gh repo view`. */
const resolveRepo = Effect.fn("LeakGuardGithub.resolveRepo")(function* () {
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
		Effect.catchTag("@kampus/leak-guard/GhCommandError", () => Effect.succeed("")),
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

// REST-only arg builders — never GraphQL. Issue comments carry the `review-*` verdict markers; the
// inline review comments are the diff-anchored surface — both are public, both get scanned.
const issueCommentsArgs = (repo: string, pr: number): ReadonlyArray<string> => [
	"api",
	"--paginate",
	`repos/${repo}/issues/${pr}/comments?per_page=100`,
];

const reviewCommentsArgs = (repo: string, pr: number): ReadonlyArray<string> => [
	"api",
	"--paginate",
	`repos/${repo}/pulls/${pr}/comments?per_page=100`,
];

/** A raw comment as either comments endpoint returns it; only these two fields are read. */
const RawComment = Schema.Struct({
	id: Schema.Number,
	body: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeComments = Schema.decodeUnknownEffect(Schema.Array(RawComment));

const fetchComments = Effect.fn("LeakGuardGithub.fetchComments")(function* (
	args: ReadonlyArray<string>,
	kind: PrComment["kind"],
) {
	const raw = yield* decodeComments(yield* json(args));
	return raw.map((c): PrComment => ({id: c.id, kind, body: c.body ?? ""}));
});

/**
 * `PrComments` — the IO shell over `gh api` REST that fetches a PR's issue + inline-review comments
 * for `scanPrComments` to re-check. Built by `PrCommentsLive`, whose `R` is `ChildProcessSpawner`.
 */
export class PrComments extends Context.Service<
	PrComments,
	{
		readonly fetch: (
			pr: number,
		) => Effect.Effect<
			ReadonlyArray<PrComment>,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
	}
>()("@kampus/leak-guard/PrComments") {}

/**
 * The live `PrComments` layer. `ChildProcessSpawner` is captured once at construction and provided
 * into each method, so the public method carries `R = never`. Repo resolution is deferred to first
 * use (`Effect.cached`, ADR 0062 §1) — the layer build is side-effect-free.
 */
export const PrCommentsLive: Layer.Layer<
	PrComments,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(PrComments)(
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const withSpawner = <A, E>(
			effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
		) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
		const repo = yield* Effect.cached(withSpawner(resolveRepo()));
		return {
			fetch: (pr) =>
				repo.pipe(
					Effect.flatMap((r) =>
						withSpawner(
							Effect.gen(function* () {
								const issue = yield* fetchComments(issueCommentsArgs(r, pr), "issue");
								const review = yield* fetchComments(reviewCommentsArgs(r, pr), "review");
								return [...issue, ...review];
							}),
						),
					),
				),
		};
	}),
);
