/**
 * The GitHub boundary for the vocabulary preflight: `RepoLabels`, the live capability that reads
 * the target repo's whole label universe over `gh api` REST so the pure core — and the per-issue
 * guard checks — can tell "this issue is out of scope" from "this repo has no such label" (#4272).
 *
 * Same service pattern as `homing-guard`'s `TriagedIssues` (epic #994): a `Context.Service` on
 * `ChildProcessSpawner`, REST only (GraphQL is broken on the kamp-us org), every infra failure a
 * typed error in the `E` channel, untrusted REST JSON Schema-decoded at the boundary.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {resolvePresence, type VocabularyPresence} from "./presence.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/vocabulary-preflight/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/vocabulary-preflight/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/vocabulary-preflight/RepoResolutionError",
	{
		message: Schema.String,
	},
) {}

export type RepoLabelsError =
	| RepoResolutionError
	| GhCommandError
	| GhParseError
	| Schema.SchemaError;

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

const runGh = Effect.fn("RepoLabels.runGh")(
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

const json = Effect.fn("RepoLabels.json")(function* (args: ReadonlyArray<string>) {
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
const resolveRepo = Effect.fn("RepoLabels.resolveRepo")(function* () {
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
		Effect.catchTag("@kampus/vocabulary-preflight/GhCommandError", () => Effect.succeed("")),
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
// whole once the label set passes 100 (the #3762 break, same shape).
const labelArgs = (repo: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"GET",
	`repos/${repo}/labels`,
	"-f",
	"per_page=100",
	"--paginate",
	"--slurp",
];

const RawLabel = Schema.Struct({name: Schema.String});
const decodePages = Schema.decodeUnknownEffect(Schema.Array(Schema.Array(RawLabel)));

const listLabels = Effect.fn("RepoLabels.list")(function* (repo: string) {
	const pages = yield* decodePages(yield* json(labelArgs(repo)));
	return pages.flat().map((l) => l.name);
});

/**
 * `RepoLabels` — the target repo's label universe. `list` is the raw set; `presence` is the one
 * question a per-issue guard asks, so each guard consults the universe through the same
 * fail-closed resolver rather than re-deriving the comparison.
 */
export class RepoLabels extends Context.Service<
	RepoLabels,
	{
		readonly list: () => Effect.Effect<ReadonlyArray<string>, RepoLabelsError>;
		readonly presence: (
			required: ReadonlyArray<string>,
		) => Effect.Effect<VocabularyPresence, RepoLabelsError>;
	}
>()("@kampus/vocabulary-preflight/RepoLabels") {}

/**
 * The live layer. The `ChildProcessSpawner` dependency is captured once at construction and
 * provided into each method body, so the public methods carry `R = never`. Both repo resolution
 * AND the label read are `Effect.cached`: a guard run asks for presence once, but caching the
 * universe keeps a future multi-question caller from re-paginating the same list.
 */
export const RepoLabelsLive: Layer.Layer<
	RepoLabels,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(RepoLabels)(
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const withSpawner = <A, E>(
			effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
		) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
		const repo = yield* Effect.cached(withSpawner(resolveRepo()));
		const universe = yield* Effect.cached(
			repo.pipe(Effect.flatMap((r) => withSpawner(listLabels(r)))),
		);
		return {
			list: () => universe,
			presence: (required: ReadonlyArray<string>) =>
				universe.pipe(Effect.map((labels) => resolvePresence(required, labels))),
		};
	}),
);
