/**
 * The GitHub boundary for `vocabulary-seed`: read the target repo's label universe and create the
 * missing labels over `gh api` REST (#4341).
 *
 * The one thing this file does that the shared `gh-io.ts` seam cannot: a failed create needs its
 * STDOUT. `gh api` prints an error's JSON body to stdout and only a terse `HTTP 422` line to
 * stderr, so a runner that keeps stderr alone throws away the `already_exists` code that separates
 * "this label is already here" (idempotent success) from "this request was wrong". `runCapture`
 * keeps all three of stdout/stderr/exit and hands the joined output to `isAlreadyExists`.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import type {LabelSpec} from "../vocabulary-preflight/vocabulary.ts";
import {isAlreadyExists, type LabelOutcome} from "./seed.ts";

/** A `gh` invocation failed in a way the seeder cannot read as an idempotent no-op. */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/vocabulary-seed/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		output: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/vocabulary-seed/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved. A seeder never guesses one. */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/vocabulary-seed/RepoResolutionError",
	{
		message: Schema.String,
	},
) {}

export type SeederError = RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError;

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

interface Captured {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

const runCapture = Effect.fn("LabelSeeder.runCapture")(
	function* (args: ReadonlyArray<string>) {
		const handle = yield* ChildProcess.make("gh", args);
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[collect(handle.stdout), collect(handle.stderr), handle.exitCode],
			{concurrency: "unbounded"},
		);
		return {stdout, stderr, exitCode} satisfies Captured;
	},
	Effect.scoped,
	(effect) =>
		Effect.catchTag(effect, "PlatformError", (cause) =>
			Effect.succeed({stdout: "", stderr: cause.message, exitCode: -1} satisfies Captured),
		),
);

const runGh = Effect.fn("LabelSeeder.runGh")(function* (args: ReadonlyArray<string>) {
	const {stdout, stderr, exitCode} = yield* runCapture(args);
	if (exitCode !== 0) {
		return yield* new GhCommandError({args, exitCode, output: `${stdout}\n${stderr}`.trim()});
	}
	return stdout;
});

const json = Effect.fn("LabelSeeder.json")(function* (args: ReadonlyArray<string>) {
	const raw = yield* runGh(args);
	return yield* Effect.try({
		try: () => JSON.parse(raw) as unknown,
		catch: (cause) =>
			new GhParseError({args, message: cause instanceof Error ? cause.message : String(cause)}),
	});
});

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * Resolve the target repo (`owner/name`), in order: an explicit `--repo`, then
 * `CLAUDE_PIPELINE_REPO` / `GITHUB_REPOSITORY`, then `gh repo view` (ADR 0062 §1).
 *
 * The explicit override comes FIRST here, unlike in the read-only preflight: this tool writes, and
 * an operator standing a repo up should be able to name the target rather than depend on which
 * directory the shell happens to sit in. With nothing resolvable it fails — a seeder that guesses
 * a repo is the bad failure this ordering exists to make unreachable.
 */
export const resolveRepo = Effect.fn("LabelSeeder.resolveRepo")(function* (
	explicit: string | undefined,
) {
	if (explicit !== undefined) {
		if (REPO_RE.test(explicit.trim())) return explicit.trim();
		return yield* new RepoResolutionError({
			message: `--repo "${explicit}" is not an owner/name pair`,
		});
	}
	const fromEnv = process.env.CLAUDE_PIPELINE_REPO ?? process.env.GITHUB_REPOSITORY;
	if (fromEnv && REPO_RE.test(fromEnv.trim())) return fromEnv.trim();
	const viewed = yield* runGh([
		"repo",
		"view",
		"--json",
		"nameWithOwner",
		"-q",
		".nameWithOwner",
	]).pipe(
		Effect.map((out) => out.trim()),
		Effect.catchTag("@kampus/vocabulary-seed/GhCommandError", () => Effect.succeed("")),
	);
	if (REPO_RE.test(viewed)) return viewed;
	return yield* new RepoResolutionError({
		message:
			"could not resolve a target repo: pass --repo owner/name, set CLAUDE_PIPELINE_REPO, " +
			"or run inside the target git repo",
	});
});

// `--slurp` because bare `--paginate` concatenates one JSON array per page, which is unparseable
// as a whole once the label set passes 100 (the #3762 break).
const listArgs = (repo: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"GET",
	`repos/${repo}/labels`,
	"-f",
	"per_page=100",
	"--paginate",
	"--slurp",
];

const createArgs = (repo: string, spec: LabelSpec): ReadonlyArray<string> => [
	"api",
	"-X",
	"POST",
	`repos/${repo}/labels`,
	"-f",
	`name=${spec.name}`,
	"-f",
	`color=${spec.color}`,
	"-f",
	`description=${spec.description}`,
];

const RawLabel = Schema.Struct({name: Schema.String});
const decodePages = Schema.decodeUnknownEffect(Schema.Array(Schema.Array(RawLabel)));

/**
 * `LabelSeeder` — the target repo's label universe plus the one write the seeder makes.
 *
 * `create` never fails on a label that already exists: it maps that 422 to `already-exists`, so
 * re-running against a partially-seeded repo is a normal, quiet outcome rather than an error. The
 * pre-read makes that path rare; keeping it makes the run idempotent even when the read is stale
 * or a concurrent operator got there first.
 */
export class LabelSeeder extends Context.Service<
	LabelSeeder,
	{
		readonly repo: Effect.Effect<string, SeederError>;
		readonly list: () => Effect.Effect<ReadonlyArray<string>, SeederError>;
		readonly create: (spec: LabelSpec) => Effect.Effect<LabelOutcome, SeederError>;
	}
>()("@kampus/vocabulary-seed/LabelSeeder") {}

/**
 * The live layer, parameterised by the explicit `--repo` override so target resolution happens
 * once per run and every later call reuses the same resolved name — a seeder that re-resolved
 * mid-run could create half its labels in one repo and half in another.
 */
export const layer = (
	explicitRepo: string | undefined,
): Layer.Layer<LabelSeeder, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.effect(LabelSeeder)(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const withSpawner = <A, E>(
				effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
			) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
			const repo = yield* Effect.cached(withSpawner(resolveRepo(explicitRepo)));
			return {
				repo,
				list: () =>
					repo.pipe(
						Effect.flatMap((r) => withSpawner(json(listArgs(r)))),
						Effect.flatMap(decodePages),
						Effect.map((pages) => pages.flat().map((l) => l.name)),
					),
				create: (spec: LabelSpec) =>
					repo.pipe(
						Effect.flatMap((r) => withSpawner(runGh(createArgs(r, spec)))),
						Effect.as<LabelOutcome>("created"),
						Effect.catchTag("@kampus/vocabulary-seed/GhCommandError", (error) =>
							isAlreadyExists(error.output)
								? Effect.succeed<LabelOutcome>("already-exists")
								: Effect.fail(error),
						),
					),
			};
		}),
	);
