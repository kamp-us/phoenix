/**
 * The GitHub boundary: decode untrusted `gh api` JSON from the Actions workflow-runs
 * endpoint into domain `WorkflowRun[]`, plus the live `Github` capability that reads
 * a trailing window of runs by shelling `gh api` REST.
 *
 * Mirrors `@kampus/epic-ledger`'s `github.ts`: Schema lives at the trust boundary
 * (`.patterns/effect-schema-validation.md`) where untyped REST enters; the `Github`
 * service is a `Context.Service` on `ChildProcessSpawner` (`.patterns/effect-context-service.md`),
 * REST only (GraphQL is broken on the kamp-us org); every infra failure is a typed
 * error in the `E` channel (`.patterns/effect-errors.md`). Repo + workflow are
 * resolved per ADR 0062 §1.
 *
 * The flake signal is the run's final `run_attempt` (see `flake-rate.ts`): the
 * workflow-runs list endpoint returns the latest attempt per run, so a run with
 * `run_attempt > 1` and `conclusion: success` is a rerun-to-green (laundered flake).
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import type {WorkflowRun} from "./flake-rate.ts";

/** The raw workflow-run fields the flake signal needs, lenient on everything else. */
const GithubRun = Schema.Struct({
	run_number: Schema.Number,
	run_attempt: Schema.Number,
	conclusion: Schema.NullOr(Schema.String),
	head_branch: Schema.NullOr(Schema.String),
	created_at: Schema.String,
});

/** The untrusted input: the `actions/.../runs` list envelope. */
const GithubRunsResponse = Schema.Struct({
	workflow_runs: Schema.Array(GithubRun),
});
export type GithubRunsResponse = (typeof GithubRunsResponse)["Type"];

const decodeRuns = Schema.decodeUnknownEffect(GithubRunsResponse);

const toWorkflowRun = (raw: (typeof GithubRun)["Type"]): WorkflowRun => ({
	runNumber: raw.run_number,
	runAttempt: raw.run_attempt,
	conclusion: raw.conclusion,
	headBranch: raw.head_branch ?? "",
	createdAt: raw.created_at,
});

/**
 * Decode untrusted workflow-runs JSON into `WorkflowRun[]`. Fails with Schema's
 * `SchemaError` if the envelope is structurally malformed; succeeds with runs ready
 * for the pure core otherwise.
 */
export const decodeWorkflowRuns = (
	input: unknown,
): Effect.Effect<ReadonlyArray<WorkflowRun>, Schema.SchemaError> =>
	Effect.map(decodeRuns(input), (res) => res.workflow_runs.map(toWorkflowRun));

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/flake-rate/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/flake-rate/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/flake-rate/RepoResolutionError",
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
 * Mirrors `epic-ledger`: the handle is spawned directly to read `exitCode` + `stderr`
 * and lower a non-zero exit into a typed error; a spawn/IO `PlatformError` folds into
 * the same `GhCommandError` (exit code `-1`).
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
 * Resolve the target repo (`owner/name`) once, per ADR 0062 §1:
 * `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` (CI) → `gh repo view`. Never silently
 * defaults to a repo, so a foreign install can't accidentally read phoenix's runs.
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
		Effect.catchTag("@kampus/flake-rate/GhCommandError", () => Effect.succeed("")),
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

/** The window of runs to read: which workflow, on which branch, how many runs back. */
export interface RunsWindow {
	/** The workflow file basename, e.g. `ci.yml` — the required check whose flake we track. */
	readonly workflow: string;
	readonly branch: string;
	/** Trailing window size, capped at the endpoint's per-page max of 100. */
	readonly perPage: number;
}

const runsArgs = (repo: string, window: RunsWindow): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/actions/workflows/${window.workflow}/runs?per_page=${window.perPage}&branch=${window.branch}`,
];

/**
 * `Github` — the IO shell over `gh api` REST. `workflowRuns` reads a trailing window
 * of one workflow's runs on a branch and decodes them to `WorkflowRun[]` for the pure
 * core. Read-only: this package never mutates GitHub state, so there is no write half.
 * Built by `GithubLive`, whose `R` is `ChildProcessSpawner`.
 */
export class Github extends Context.Service<
	Github,
	{
		readonly workflowRuns: (
			window: RunsWindow,
		) => Effect.Effect<
			ReadonlyArray<WorkflowRun>,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
	}
>()("@kampus/flake-rate/Github") {}

const loadRuns = Effect.fn("Github.workflowRuns")(function* (repo: string, window: RunsWindow) {
	const args = runsArgs(repo, window);
	const raw = yield* runGh(args);
	return yield* decodeWorkflowRuns(yield* parseJson(args, raw));
});

/**
 * The live `Github` layer. Mirrors `epic-ledger`: the `ChildProcessSpawner` is
 * captured at construction and provided into each method, so public methods carry
 * `R = never`; repo resolution is `Effect.cached` and deferred to first use (the
 * layer build is side-effect-free, `--help`/`--version` never resolve a repo).
 * Provide `NodeServices.layer` to satisfy the spawner.
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
				workflowRuns: (window: RunsWindow) =>
					repo.pipe(Effect.flatMap((r) => withSpawner(loadRuns(r, window)))),
			};
		}),
	);
