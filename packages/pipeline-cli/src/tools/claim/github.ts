/**
 * The GitHub boundary for the `claim` verb: a read-only `Github` capability that
 * resolves "is this issue's claim mine?" over `gh api` REST, driving the IO-free
 * `claim-is-mine.ts` decision (which itself reuses epic-lock's `resolveClaim` core).
 *
 * Same `Context.Service`-on-`ChildProcessSpawner` shape as epic-lock's `github.ts`
 * (the epic #994 template child): REST only (GraphQL is broken on the kamp-us org),
 * every infra failure a typed error in the `E` channel (`.patterns/effect-errors.md`)
 * — a non-zero `gh` exit is `GhCommandError`, malformed output is `GhParseError`, an
 * unresolvable repo is `RepoResolutionError` — and Schema-decoded untrusted REST JSON
 * at the boundary. Unlike epic-lock this verb only READS: it lists the issue's
 * comments, resolves the write+ authorized-author set (ADR 0055), and resolves the
 * earliest authorized claim against our session id. No label, no comment write.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import type {ClaimComment} from "../epic-lock/claim-resolution.ts";
import {type ClaimVerdict, claimIsMine} from "./claim-is-mine.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/claim/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/claim/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/claim/RepoResolutionError",
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
 * `ChildProcess.make` is spawned directly to read `exitCode` + `stderr` and lower a
 * non-zero exit into a typed error; a spawn/IO `PlatformError` (e.g. `gh` not on
 * PATH) folds into the same `GhCommandError` (exit code `-1`).
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

const json = Effect.fn("Github.json")(function* (args: ReadonlyArray<string>) {
	return yield* parseJson(args, yield* runGh(args));
});

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * Resolve the target repo (`owner/name`) once, per ADR 0062 §1, in order:
 * `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` (CI) → `gh repo view`. Never silently
 * defaults: with no env and no resolvable current repo it fails `RepoResolutionError`.
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
		Effect.catchTag("@kampus/claim/GhCommandError", () => Effect.succeed("")),
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

// REST-only arg builders — never GraphQL.

const listCommentsArgs = (repo: string, issue: number): ReadonlyArray<string> => [
	"api",
	"--paginate",
	`repos/${repo}/issues/${issue}/comments?per_page=100`,
];

const permissionArgs = (repo: string, login: string): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/collaborators/${login}/permission`,
	"--jq",
	".permission",
];

/** A raw comment as the issues/comments endpoint returns it; only these fields are read. */
const RawComment = Schema.Struct({
	id: Schema.Number,
	created_at: Schema.String,
	body: Schema.optionalKey(Schema.NullOr(Schema.String)),
	user: Schema.NullOr(Schema.Struct({login: Schema.String})),
});
const decodeComments = Schema.decodeUnknownEffect(Schema.Array(RawComment));

const toClaimComment = (raw: (typeof RawComment)["Type"]): ClaimComment => ({
	id: raw.id,
	author: raw.user?.login ?? "",
	createdAt: raw.created_at,
	body: raw.body ?? "",
});

const listClaimComments = Effect.fn("Github.listClaimComments")(function* (
	repo: string,
	issue: number,
) {
	const raw = yield* decodeComments(yield* json(listCommentsArgs(repo, issue)));
	return raw.map(toClaimComment);
});

/**
 * The write+ collaborator subset of `logins` — the ADR 0055 trust root. Each login is
 * probed with `collaborators/<login>/permission`; a non-`admin|maintain|write`
 * permission, or any `gh` fault on the probe (a non-collaborator commonly 404s),
 * drops the login. A forged claim from a non-collaborator therefore never enters the
 * authorized set the decision resolves over.
 */
const authorizedAuthors = Effect.fn("Github.authorizedAuthors")(function* (
	repo: string,
	logins: ReadonlyArray<string>,
) {
	const results = yield* Effect.forEach(
		logins,
		(login) =>
			runGh(permissionArgs(repo, login)).pipe(
				Effect.map((out) => ({login, permission: out.trim()})),
				Effect.catchTag("@kampus/claim/GhCommandError", () =>
					Effect.succeed({login, permission: "none"}),
				),
			),
		{concurrency: "unbounded"},
	);
	return results
		.filter(
			(r) => r.permission === "admin" || r.permission === "maintain" || r.permission === "write",
		)
		.map((r) => r.login);
});

/**
 * Resolve whether the earliest authorized claim on `issue` is ours, default-deny.
 * Lists the issue's comments, resolves the write+ authorized-author set from the
 * distinct claim-marker authors, then hands both plus our session id to the pure
 * `claimIsMine` decision. Every un-resolvable state (no authorized claim, foreign
 * owner, missing session) answers not-mine — the fail-safe the decision guarantees.
 */
const isMine = Effect.fn("Github.isMine")(function* (
	repo: string,
	issue: number,
	sessionId: string | null,
) {
	const comments = yield* listClaimComments(repo, issue);
	const authors = [...new Set(comments.map((c) => c.author).filter((a) => a.length > 0))];
	const authorized = yield* authorizedAuthors(repo, authors);
	return claimIsMine({comments, authorizedAuthors: authorized, sessionId});
});

/**
 * `Github` — the read-only IO shell over `gh api` REST. `isMine` is the one verb the
 * `claim` tool exposes: it takes the issue number and the resolving session id and
 * returns the default-deny `ClaimVerdict`. Built by `GithubLive`, whose `R` is
 * `ChildProcessSpawner`: provide the platform spawner (`NodeServices.layer`) in
 * production; a test provides a mock spawner via `ChildProcessSpawner.make`.
 */
export class Github extends Context.Service<
	Github,
	{
		readonly isMine: (
			issue: number,
			sessionId: string | null,
		) => Effect.Effect<
			ClaimVerdict,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
	}
>()("@kampus/claim/Github") {}

/**
 * The live `Github` layer. The `ChildProcessSpawner` dependency is captured once at
 * construction and provided *into* the method body, so the public method carries
 * `R = never`. Repo resolution is deferred to first use (`Effect.cached`, ADR 0062
 * §1): the layer build is side-effect-free, and `RepoResolutionError` lives in the
 * method's `E` channel, raised only when `isMine` actually reads.
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
				isMine: (issue: number, sessionId: string | null) =>
					repo.pipe(Effect.flatMap((r) => withSpawner(isMine(r, issue, sessionId)))),
			};
		}),
	);
