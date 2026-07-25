/**
 * The GitHub boundary for `homing-guard`: the live `TriagedIssues` capability that reads
 * the open `status:triaged` set over `gh api` REST, so the pure core can judge it. Same
 * service pattern as `roadmap-guard`'s `Milestones` (epic #994): a `Context.Service` on
 * `ChildProcessSpawner`, REST only (GraphQL is broken on the kamp-us org), every infra
 * failure a typed error in the `E` channel, untrusted REST JSON Schema-decoded at the
 * boundary into the domain `TriagedIssue` the core resolves over.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {TRIAGED_LABEL, type TriagedIssue} from "./homing-guard.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/homing-guard/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/homing-guard/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/homing-guard/RepoResolutionError",
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
 * direct-spawn shape `roadmap-guard`/`checks` use so a non-zero exit + stderr lower into a
 * typed error rather than a throw. A spawn/IO `PlatformError` (`gh` not on PATH) folds in as
 * exit `-1`.
 */
const runGh = Effect.fn("TriagedIssues.runGh")(
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

const json = Effect.fn("TriagedIssues.json")(function* (args: ReadonlyArray<string>) {
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
 * `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` (CI) → `gh repo view`. Never silently
 * defaults — with no env and no resolvable current repo it fails `RepoResolutionError`.
 */
const resolveRepo = Effect.fn("TriagedIssues.resolveRepo")(function* () {
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
		Effect.catchTag("@kampus/homing-guard/GhCommandError", () => Effect.succeed("")),
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

// `--slurp` because bare `--paginate` concatenates one JSON array per page — unparseable as a
// whole once the triaged set passes 100, the exact break `checks` hit live (#3762). `--slurp`
// wraps the pages in an array instead, which the page-of-pages decode below flattens.
const triagedArgs = (repo: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"GET",
	`repos/${repo}/issues`,
	"-f",
	"state=open",
	"-f",
	`labels=${TRIAGED_LABEL}`,
	"-f",
	"per_page=100",
	"--paginate",
	"--slurp",
];

const oneIssueArgs = (repo: string, issue: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/issues/${issue}`,
];

/** A raw issue as the issues endpoint returns it; `pull_request` present ⇒ a PR, filtered out. */
const RawIssue = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	labels: Schema.Array(Schema.Struct({name: Schema.String})),
	milestone: Schema.NullOr(Schema.Struct({number: Schema.Number})),
	pull_request: Schema.optionalKey(Schema.Unknown),
});
type RawIssue = typeof RawIssue.Type;

const decodePages = Schema.decodeUnknownEffect(Schema.Array(Schema.Array(RawIssue)));
const decodeIssue = Schema.decodeUnknownEffect(RawIssue);

const toIssue = (raw: RawIssue): TriagedIssue => ({
	number: raw.number,
	title: raw.title,
	milestone: raw.milestone?.number ?? null,
	labels: raw.labels.map((l) => l.name),
});

// The label filter is applied AGAIN on the client for the single-issue read, whose endpoint
// takes no `labels` filter: an issue that is not `status:triaged` is out of scope, and the
// core reads an empty set in issue scope as exactly that (a pass, not a fail).
const isTriaged = (issue: TriagedIssue): boolean => issue.labels.includes(TRIAGED_LABEL);

const listTriaged = Effect.fn("TriagedIssues.list")(function* (repo: string) {
	const pages = yield* decodePages(yield* json(triagedArgs(repo)));
	return pages
		.flat()
		.filter((r) => r.pull_request === undefined)
		.map(toIssue);
});

const getTriaged = Effect.fn("TriagedIssues.get")(function* (repo: string, issue: number) {
	const raw = yield* decodeIssue(yield* json(oneIssueArgs(repo, issue)));
	if (raw.pull_request !== undefined) return [];
	const one = toIssue(raw);
	return isTriaged(one) ? [one] : [];
});

/**
 * `TriagedIssues` — the IO shell over `gh api` REST for `homing-guard`. `list` reads the
 * whole open `status:triaged` set; `get` reads one issue and yields it only if it is
 * triaged (an empty result the core reads as out-of-scope). Built by `TriagedIssuesLive`,
 * whose `R` is `ChildProcessSpawner`.
 */
export class TriagedIssues extends Context.Service<
	TriagedIssues,
	{
		readonly list: () => Effect.Effect<
			ReadonlyArray<TriagedIssue>,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
		readonly get: (
			issue: number,
		) => Effect.Effect<
			ReadonlyArray<TriagedIssue>,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
	}
>()("@kampus/homing-guard/TriagedIssues") {}

/**
 * The live `TriagedIssues` layer. The `ChildProcessSpawner` dependency is captured once at
 * construction and provided into each method body, so the public methods carry `R = never`.
 * Repo resolution is deferred to first use (`Effect.cached`, ADR 0062 §1): the layer build is
 * side-effect-free, and `RepoResolutionError` lives in the methods' `E` channel.
 */
export const TriagedIssuesLive: Layer.Layer<
	TriagedIssues,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(TriagedIssues)(
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const withSpawner = <A, E>(
			effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
		) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
		const repo = yield* Effect.cached(withSpawner(resolveRepo()));
		return {
			list: () => repo.pipe(Effect.flatMap((r) => withSpawner(listTriaged(r)))),
			get: (issue: number) => repo.pipe(Effect.flatMap((r) => withSpawner(getTriaged(r, issue)))),
		};
	}),
);
