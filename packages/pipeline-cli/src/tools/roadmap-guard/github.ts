/**
 * The GitHub boundary for `roadmap-guard`: the live `Milestones` capability that reads
 * the repo's milestone projection over `gh api` REST, so the pure core can validate
 * ROADMAP.md against it. Same service pattern as `campaign`'s `Github` (epic #994): a
 * `Context.Service` on `ChildProcessSpawner`, REST only (GraphQL is broken on the
 * kamp-us org), every infra failure a typed error in the `E` channel, untrusted REST
 * JSON Schema-decoded at the boundary into the domain `Milestone` the core resolves over.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import type {Milestone} from "./roadmap-guard.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/roadmap-guard/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/roadmap-guard/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/roadmap-guard/RepoResolutionError",
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
 * Run `gh <args>` and return stdout, failing `GhCommandError` on a non-zero exit — the
 * same direct-spawn shape `campaign`/`verdict` use so a non-zero exit + stderr lower
 * into a typed error rather than a throw. A spawn/IO `PlatformError` (e.g. `gh` not on
 * PATH) folds in as exit `-1`.
 */
const runGh = Effect.fn("Milestones.runGh")(
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

const json = Effect.fn("Milestones.json")(function* (args: ReadonlyArray<string>) {
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
const resolveRepo = Effect.fn("Milestones.resolveRepo")(function* () {
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
		Effect.catchTag("@kampus/roadmap-guard/GhCommandError", () => Effect.succeed("")),
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

// `state=all` so I1 can resolve a pin to a CLOSED milestone (a done arc/campaign), while
// I3 filters to open ones — the guard needs both projections. `--paginate` for >100.
const milestonesArgs = (repo: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"GET",
	`repos/${repo}/milestones`,
	"-f",
	"state=all",
	"-f",
	"per_page=100",
	"--paginate",
];

/** A raw milestone as the milestones endpoint returns it; only these fields are read. */
const RawMilestone = Schema.Struct({
	number: Schema.Number,
	state: Schema.Literals(["open", "closed"]),
	title: Schema.String,
});
const decodeMilestones = Schema.decodeUnknownEffect(Schema.Array(RawMilestone));

const listMilestones = Effect.fn("Milestones.list")(function* (repo: string) {
	const args = milestonesArgs(repo);
	const raw = yield* decodeMilestones(yield* json(args));
	return raw.map((m): Milestone => ({number: m.number, state: m.state, title: m.title}));
});

/**
 * `Milestones` — the IO shell over `gh api` REST for `roadmap-guard`. `list` reads the
 * repo's milestone projection (all states). Built by `MilestonesLive`, whose `R` is
 * `ChildProcessSpawner`.
 */
export class Milestones extends Context.Service<
	Milestones,
	{
		readonly list: () => Effect.Effect<
			ReadonlyArray<Milestone>,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
	}
>()("@kampus/roadmap-guard/Milestones") {}

/**
 * The live `Milestones` layer. The `ChildProcessSpawner` dependency is captured once at
 * construction and provided into each method body, so the public method carries
 * `R = never`. Repo resolution is deferred to first use (`Effect.cached`, ADR 0062 §1):
 * the layer build is side-effect-free, and `RepoResolutionError` lives in the method's
 * `E` channel, raised only when `list` actually reads.
 */
export const MilestonesLive: Layer.Layer<
	Milestones,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(Milestones)(
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const withSpawner = <A, E>(
			effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
		) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
		const repo = yield* Effect.cached(withSpawner(resolveRepo()));
		return {
			list: () => repo.pipe(Effect.flatMap((r) => withSpawner(listMilestones(r)))),
		};
	}),
);
