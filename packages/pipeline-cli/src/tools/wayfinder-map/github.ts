/**
 * The GitHub boundary: decode untrusted `gh api` JSON into a domain
 * `WayfinderMapLedger` (`decodeMapLedger`), plus the live `Github` capability
 * that *reads* one by shelling `gh api` REST.
 *
 * Per `.patterns/effect-schema-validation.md`, Schema lives at the trust boundary
 * — here, where genuinely untyped REST responses enter — and not past it:
 * everything downstream (`validateMap`, `isGraduationReady`, `mapSignature`) is
 * total over the decoded ledger. The raw GitHub shapes are decoded leniently (only
 * the fields the floor needs) and the map body's four sections are parsed at decode
 * time, so the domain model never carries raw markdown and the validator never
 * parses. The map's real sub-issue numbers come from the `sub_issues` endpoint,
 * resolved here at the boundary, never by parsing the body.
 *
 * REST only, never GraphQL (broken on the kamp-us org). Every infra failure is a
 * typed error in the `E` channel, never a throw (`.patterns/effect-errors.md`).
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import type {WayfinderMapLedger} from "./Map.ts";
import {parseMapBody} from "./markdown.ts";

/** A null/absent issue body normalizes to the empty string before parsing. */
const GithubBody = Schema.optionalKey(Schema.NullOr(Schema.String));

/** The raw GitHub issue fields the ledger needs, lenient on everything else. */
const GithubIssue = Schema.Struct({
	number: Schema.Number,
	body: GithubBody,
});

/** A sub-issue ref as the `sub_issues` endpoint returns it; only `number` is read. */
const SubIssueRef = Schema.Struct({number: Schema.Number});

/** The untrusted input: the map issue plus its native sub-issues' numbers. */
export const GithubMapInput = Schema.Struct({
	map: GithubIssue,
	subIssues: Schema.Array(SubIssueRef),
});
export type GithubMapInput = (typeof GithubMapInput)["Type"];

const decodeInput = Schema.decodeUnknownEffect(GithubMapInput);

const bodyOf = (body: string | null | undefined): string => body ?? "";

const toLedger = (input: GithubMapInput): WayfinderMapLedger => ({
	number: input.map.number,
	map: parseMapBody(bodyOf(input.map.body)),
	subIssues: input.subIssues.map((s) => s.number),
});

/**
 * Decode untrusted GitHub JSON into a `WayfinderMapLedger`, parsing the map body's
 * four sections and reading its sub-issue numbers at the boundary. Fails with
 * Schema's `SchemaError` if the JSON is structurally malformed (missing `number`);
 * succeeds with a ledger ready for `validateMap` otherwise.
 */
export const decodeMapLedger = (
	input: unknown,
): Effect.Effect<WayfinderMapLedger, Schema.SchemaError> =>
	Effect.map(decodeInput(input), toLedger);

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/wayfinder-map/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/wayfinder-map/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/wayfinder-map/RepoResolutionError",
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
 * Run `gh <args>` and return stdout, failing `GhCommandError` on a non-zero exit.
 * A spawn/IO `PlatformError` (e.g. `gh` not on PATH) folds into the same typed
 * error (exit code `-1`); the `E` channel carries only this package's typed
 * errors, never a raw platform fault.
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

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * Resolve the target repo (`owner/name`) once, per ADR 0062 §1, in order:
 * `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` (CI) → `gh repo view`. Never
 * silently defaults to a repo: with no env and no resolvable current repo it fails
 * `RepoResolutionError`, so a foreign install can't accidentally operate on phoenix.
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
		Effect.catchTag("@kampus/wayfinder-map/GhCommandError", () => Effect.succeed("")),
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

const issueArgs = (repo: string, number: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/issues/${number}`,
];

const subIssuesArgs = (repo: string, number: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/issues/${number}/sub_issues?per_page=100`,
];

const decodeSubIssueRefs = Schema.decodeUnknownEffect(Schema.Array(SubIssueRef));

/**
 * `Github` — the IO shell over `gh api` REST. `mapLedger` is the tool's one
 * capability: a `wayfinder:map` issue number → a decoded `WayfinderMapLedger`
 * ready for the pure floor. Read-only by construction — this tool parses and
 * validates, it never mutates the map (the `wayfinder` skill's work/emit modes
 * own writes). Built by `GithubLive`, whose `R` is `ChildProcessSpawner`.
 */
export class Github extends Context.Service<
	Github,
	{
		readonly mapLedger: (
			mapNumber: number,
		) => Effect.Effect<
			WayfinderMapLedger,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
	}
>()("@kampus/wayfinder-map/Github") {}

const json = Effect.fn("Github.json")(function* (args: ReadonlyArray<string>) {
	return yield* parseJson(args, yield* runGh(args));
});

const loadMapLedger = Effect.fn("Github.mapLedger")(function* (repo: string, mapNumber: number) {
	const map = yield* json(issueArgs(repo, mapNumber));
	const subIssues = yield* decodeSubIssueRefs(yield* json(subIssuesArgs(repo, mapNumber)));
	return yield* decodeMapLedger({map, subIssues});
});

/**
 * The live `Github` layer. The `ChildProcessSpawner` dependency is captured once
 * at construction and provided into each method body, so the service's public
 * methods carry `R = never`. Repo resolution is deferred to first use
 * (`Effect.cached`), so the layer build is side-effect-free and `--help` never
 * triggers it; a real subcommand resolves it once per process.
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
				mapLedger: (mapNumber: number) =>
					repo.pipe(Effect.flatMap((r) => withSpawner(loadMapLedger(r, mapNumber)))),
			};
		}),
	);
