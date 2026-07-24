/**
 * The GitHub boundary for `checks`: resolve a PR's head SHA and fetch that head's check runs
 * + combined status over `gh api` REST, feeding the IO-free `checks.ts` rollup.
 *
 * Same service pattern as the `verdict` / `orphan-heal` children (epic #994): a
 * `Context.Service` on `ChildProcessSpawner`, REST only (GraphQL is broken on the kamp-us
 * org), every infra failure a typed error in the `E` channel, untrusted REST JSON
 * Schema-decoded at the boundary.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {type ChecksRollup, rollupChecks} from "./checks.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/checks/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/checks/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/checks/RepoResolutionError",
	{message: Schema.String},
) {}

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

const runGh = Effect.fn("Checks.runGh")(
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

const json = Effect.fn("Checks.json")(function* (args: ReadonlyArray<string>) {
	return yield* parseJson(args, yield* runGh(args));
});

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/** Resolve the target repo (`owner/name`) per ADR 0062 §1: env override → `GITHUB_REPOSITORY` → `gh repo view`. */
const resolveRepo = Effect.fn("Checks.resolveRepo")(function* () {
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
		Effect.catchTag("@kampus/checks/GhCommandError", () => Effect.succeed("")),
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

const RawCheckRun = Schema.Struct({
	id: Schema.Number,
	name: Schema.String,
	conclusion: Schema.NullOr(Schema.String),
	started_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
	completed_at: Schema.NullOr(Schema.String),
});
/**
 * The check-runs endpoint returns an OBJECT, so `--paginate` alone emits one JSON object per
 * page — concatenated, unparseable as a whole. `--slurp` wraps the pages in an array instead;
 * decoding that array and flattening is what makes a >100-run head readable at all. (Verified
 * live: the #3762 head returns 123 runs over 2 pages, and the unslurped read throws.)
 */
const RawCheckRunPages = Schema.Array(Schema.Struct({check_runs: Schema.Array(RawCheckRun)}));
const decodeCheckRunPages = Schema.decodeUnknownEffect(RawCheckRunPages);

const RawCombinedStatus = Schema.Struct({state: Schema.String, total_count: Schema.Number});
const decodeCombinedStatus = Schema.decodeUnknownEffect(RawCombinedStatus);

const RawPr = Schema.Struct({head: Schema.Struct({sha: Schema.String})});
const decodePr = Schema.decodeUnknownEffect(RawPr);

const headSha = Effect.fn("Checks.headSha")(function* (repo: string, pr: number) {
	const args = ["api", `repos/${repo}/pulls/${pr}`];
	return (yield* decodePr(yield* json(args))).head.sha;
});

/**
 * Read a head's rolled-up CI state. Paginating is load-bearing: a busy head easily exceeds one
 * page (the #3762 reproduction head carried 123 runs), and a truncated page can hide the very
 * run that supersedes a stale red.
 */
const read = Effect.fn("Checks.read")(function* (repo: string, sha: string) {
	const checkArgs = [
		"api",
		"--paginate",
		"--slurp",
		`repos/${repo}/commits/${sha}/check-runs?per_page=100`,
	];
	const statusArgs = ["api", `repos/${repo}/commits/${sha}/status`];
	const [pages, status] = yield* Effect.all(
		[
			decodeCheckRunPages(yield* json(checkArgs)),
			decodeCombinedStatus(yield* json(statusArgs)),
		] as const,
		{concurrency: "unbounded"},
	);
	return rollupChecks({
		checkRuns: pages
			.flatMap((page) => page.check_runs)
			.map((r) => ({
				id: r.id,
				name: r.name,
				conclusion: r.conclusion,
				startedAt: r.started_at ?? null,
				completedAt: r.completed_at,
			})),
		combinedStatus: {state: status.state, totalCount: status.total_count},
	});
});

type GhError = RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError;

/**
 * `Github` — the IO shell over `gh api` REST for the head-CI reads. Built by `GithubLive`,
 * whose `R` is `ChildProcessSpawner`; repo resolution is cached and deferred to first use
 * (ADR 0062 §1), so the layer build is side-effect-free.
 */
export class Github extends Context.Service<
	Github,
	{
		readonly repoName: () => Effect.Effect<string, GhError>;
		readonly headSha: (pr: number) => Effect.Effect<string, GhError>;
		readonly read: (sha: string) => Effect.Effect<ChecksRollup, GhError>;
	}
>()("@kampus/checks/Github") {}

export const GithubLive: Layer.Layer<Github, never, ChildProcessSpawner.ChildProcessSpawner> =
	Layer.effect(Github)(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const withSpawner = <A, E>(
				effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
			) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
			const repo = yield* Effect.cached(withSpawner(resolveRepo()));
			return {
				repoName: () => repo,
				headSha: (pr) => repo.pipe(Effect.flatMap((r) => withSpawner(headSha(r, pr)))),
				read: (sha) => repo.pipe(Effect.flatMap((r) => withSpawner(read(r, sha)))),
			};
		}),
	);
