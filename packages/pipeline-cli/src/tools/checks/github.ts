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
import {type CheckSuite, type ChecksRollup, rollupChecks} from "./checks.ts";

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

/**
 * The head's CI state could not be read as data — the transport failed, or the body decoded to
 * something that is not the check-runs envelope (a `{"message": "Not Found"}` error object, a
 * truncated page, a non-array). It is the typed "unknown" the gate refuses on: a caller must be
 * able to tell "I could not read this head" from any colour, and never resolve it to green
 * (#3999).
 */
export class HeadCiUnreadable extends Schema.TaggedErrorClass<HeadCiUnreadable>()(
	"@kampus/checks/HeadCiUnreadable",
	{sha: Schema.String, reason: Schema.String},
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
	status: Schema.optionalKey(Schema.NullOr(Schema.String)),
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

const RawCheckSuite = Schema.Struct({
	id: Schema.Number,
	status: Schema.NullOr(Schema.String),
	latest_check_runs_count: Schema.Number,
	app: Schema.optionalKey(Schema.NullOr(Schema.Struct({slug: Schema.NullOr(Schema.String)}))),
});
const RawCheckSuitePages = Schema.Array(Schema.Struct({check_suites: Schema.Array(RawCheckSuite)}));
const decodeCheckSuitePages = Schema.decodeUnknownEffect(RawCheckSuitePages);

const RawPr = Schema.Struct({head: Schema.Struct({sha: Schema.String})});
const decodePr = Schema.decodeUnknownEffect(RawPr);

/**
 * A one-line, operator-readable cause. The tagged errors carry their detail in FIELDS, not in
 * `message`, so a bare `.message` renders empty — and an unknown that can't say why it's unknown
 * is not actionable.
 */
const describeFault = (cause: GhCommandError | GhParseError | Schema.SchemaError): string => {
	switch (cause._tag) {
		case "@kampus/checks/GhCommandError":
			return `gh exited ${cause.exitCode}: ${cause.stderr.trim() || "(no stderr)"}`;
		case "@kampus/checks/GhParseError":
			return `gh output was not JSON: ${cause.message}`;
		default:
			return `response did not match the expected shape: ${cause.message}`;
	}
};

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
	const suiteArgs = [
		"api",
		"--paginate",
		"--slurp",
		`repos/${repo}/commits/${sha}/check-suites?per_page=100`,
	];
	// The two GATING reads: their shape is decoded BEFORE any conclusion is read, and a fault in
	// either resolves to the typed `HeadCiUnreadable` — never to a colour.
	const gating = Effect.all(
		[
			Effect.flatMap(json(checkArgs), decodeCheckRunPages),
			Effect.flatMap(json(statusArgs), decodeCombinedStatus),
		] as const,
		{concurrency: "unbounded"},
	).pipe(Effect.catch((cause) => new HeadCiUnreadable({sha, reason: describeFault(cause)})));
	// The suites read is DIAGNOSTIC, so it degrades instead of blocking: suites cannot move the
	// conclusion (see `RollupInput.suites`), and letting a flaky side read refuse a merge would
	// re-introduce the false-negative block this whole change removes.
	const suites = Effect.flatMap(json(suiteArgs), decodeCheckSuitePages).pipe(
		Effect.map((suitePages) =>
			suitePages
				.flatMap((page) => page.check_suites)
				.map(
					(s): CheckSuite => ({
						id: s.id,
						status: s.status,
						latestCheckRunsCount: s.latest_check_runs_count,
						appSlug: s.app?.slug ?? null,
					}),
				),
		),
		Effect.orElseSucceed((): ReadonlyArray<CheckSuite> => []),
	);
	const [[pages, status], checkSuites] = yield* Effect.all([gating, suites] as const, {
		concurrency: "unbounded",
	});
	return rollupChecks({
		checkRuns: pages
			.flatMap((page) => page.check_runs)
			.map((r) => ({
				id: r.id,
				name: r.name,
				conclusion: r.conclusion,
				status: r.status ?? null,
				startedAt: r.started_at ?? null,
				completedAt: r.completed_at,
			})),
		combinedStatus: {state: status.state, totalCount: status.total_count},
		suites: checkSuites,
	});
});

type GhError = RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError;

/** `read`'s error channel: every fault on the gating reads arrives as the one typed unknown. */
type ReadError = RepoResolutionError | HeadCiUnreadable;

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
		readonly read: (sha: string) => Effect.Effect<ChecksRollup, ReadError>;
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
