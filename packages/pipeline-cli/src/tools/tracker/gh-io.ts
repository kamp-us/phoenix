/**
 * The shared `gh api` REST IO seam for the crew's tracker consumers — the single source of the
 * `runGh` / `resolveRepo` / `authorizedAuthors` / `RawComment` idiom the `Tracker` service, the
 * `epic-lock` lock, and the `verdict` gate each used to re-copy (#3262 AC 5, the same-commit
 * adoption follow-up). Consolidating it here is what makes those three consumers stop drifting
 * their own copies of the same procedure.
 *
 * The seam is deliberately domain-free: it is the `gh`-over-REST plumbing (spawn, JSON parse,
 * repo resolution, the ADR 0055 write+ ACL gate, the raw comment shape), NOT the claim/verdict
 * decision. Each consumer keeps its own domain core (`claim-resolution.ts`, `verdict-match.ts`)
 * and maps the `RawComment` boundary type into its own domain comment. Two rules bind it, the
 * same two that bound the copies:
 *
 *  - **REST only** — GraphQL is broken on the kamp-us org, so every call is `gh api …`.
 *  - **Typed failures, never a throw (`.patterns/effect-errors.md`).** A non-zero `gh` exit is
 *    `GhCommandError`, malformed output `GhParseError`, an unresolvable repo `RepoResolutionError`;
 *    untrusted REST JSON is Schema-decoded at the boundary (`.patterns/effect-schema-validation.md`).
 */
import {Effect, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess} from "effect/unstable/process";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, 422 missing label, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/gh-io/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/gh-io/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/gh-io/RepoResolutionError",
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
 * `ChildProcessSpawner.string` surfaces only spawn/IO faults, not the process's own exit code —
 * so the handle is spawned directly to read `exitCode` + `stderr` and lower a non-zero exit into a
 * typed error rather than a throw. A spawn/IO `PlatformError` (e.g. `gh` off PATH) folds into the
 * same typed error as exit `-1`.
 */
export const runGh = Effect.fn("GhIo.runGh")(
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

/** Run `gh <args>` and JSON-parse its stdout, lowering a parse failure into `GhParseError`. */
export const json = Effect.fn("GhIo.json")(function* (args: ReadonlyArray<string>) {
	return yield* parseJson(args, yield* runGh(args));
});

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * Resolve the target repo (`owner/name`) once, per ADR 0062 §1, in order:
 * `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` (CI) → `gh repo view`. Never silently defaults to a
 * repo: with no env and no resolvable current repo it fails `RepoResolutionError`, so a foreign
 * install can't accidentally operate on phoenix.
 */
export const resolveRepo = Effect.fn("GhIo.resolveRepo")(function* () {
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
		Effect.catchTag("@kampus/gh-io/GhCommandError", () => Effect.succeed("")),
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

// REST-only arg builders shared across the tracker consumers — never GraphQL.

export const listCommentsArgs = (repo: string, target: number): ReadonlyArray<string> => [
	"api",
	"--paginate",
	`repos/${repo}/issues/${target}/comments?per_page=100`,
];

// A comment POST that returns the new comment id — the claim marker and the verdict marker are
// both a body POST that reads back `.id`, single-sourced so the consumers can't drift.
export const postCommentArgs = (
	repo: string,
	target: number,
	body: string,
): ReadonlyArray<string> => [
	"api",
	"-X",
	"POST",
	`repos/${repo}/issues/${target}/comments`,
	"-f",
	`body=${body}`,
	"--jq",
	".id",
];

export const patchCommentArgs = (repo: string, id: number, body: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"PATCH",
	`repos/${repo}/issues/comments/${id}`,
	"-f",
	`body=${body}`,
	"--jq",
	".id",
];

export const deleteCommentArgs = (repo: string, id: number): ReadonlyArray<string> => [
	"api",
	"-X",
	"DELETE",
	`repos/${repo}/issues/comments/${id}`,
];

// The read-back GET for a post's self-verify (#3019): re-fetch the single comment we just upserted
// and return its LANDED body, so the marker/leak-clean shape is re-checked as it actually landed.
export const getCommentBodyArgs = (repo: string, id: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/issues/comments/${id}`,
	"--jq",
	".body",
];

export const whoAmIArgs: ReadonlyArray<string> = ["api", "user", "--jq", ".login"];

const permissionArgs = (repo: string, login: string): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/collaborators/${login}/permission`,
	"--jq",
	".permission",
];

/** A raw comment as the issues/comments endpoint returns it; only these fields are read. */
export const RawComment = Schema.Struct({
	id: Schema.Number,
	created_at: Schema.String,
	body: Schema.optionalKey(Schema.NullOr(Schema.String)),
	user: Schema.NullOr(Schema.Struct({login: Schema.String})),
});
export const decodeComments = Schema.decodeUnknownEffect(Schema.Array(RawComment));

/**
 * The write+ collaborator subset of `logins` — the ADR 0055 trust root. Each login is probed with
 * `collaborators/<login>/permission`; a non-`admin|maintain|write` permission, or any `gh` fault on
 * the probe (a non-collaborator commonly 404s), drops the login. A forged claim/marker from a
 * non-collaborator therefore never enters the authorized set a consumer's core resolves over.
 */
export const authorizedAuthors = Effect.fn("GhIo.authorizedAuthors")(function* (
	repo: string,
	logins: ReadonlyArray<string>,
) {
	const results = yield* Effect.forEach(
		logins,
		(login) =>
			runGh(permissionArgs(repo, login)).pipe(
				Effect.map((out) => ({login, permission: out.trim()})),
				Effect.catchTag("@kampus/gh-io/GhCommandError", () =>
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
