/**
 * The GitHub boundary for `verdict`: the live `Github` capability that reads and upserts
 * ADR-0058 SHA-bound gate verdicts over `gh api` REST, driving the IO-free
 * `verdict-match.ts` core.
 *
 * Same service pattern as the `epic-lock` template child (epic #994): a `Context.Service`
 * on `ChildProcessSpawner`, REST only (GraphQL is broken on the kamp-us org), every infra
 * failure a typed error in the `E` channel (`GhCommandError` / `GhParseError` /
 * `RepoResolutionError`), untrusted REST JSON Schema-decoded at the boundary into the domain
 * `VerdictComment` the core resolves over.
 *
 * Two verbs:
 *  - `read(pr, gate, expect, headOverride)` — resolve the PR's current head (REST), author-gate
 *    marker authors to write+ collaborators (ADR 0055), and run `resolveVerdict` to classify
 *    the namespace against that head. The consumer branches on the returned outcome.
 *  - `post(pr, gate, body)` — the ADR-0058 rule-2 UPSERT: guard the body's first line is *this*
 *    gate's marker (fail-closed on a cross-namespace body), then PATCH our own prior marker in
 *    the namespace if one exists, else POST a fresh one — exactly one verdict comment per (PR, gate).
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {
	emissionDefect,
	namespaceRe,
	type Polarity,
	resolveVerdict,
	type VerdictComment,
	type VerdictGate,
	type VerdictOutcome,
} from "./verdict-match.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/verdict/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/verdict/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/verdict/RepoResolutionError",
	{
		message: Schema.String,
	},
) {}

/** A malformed request the caller must fix — e.g. a `post` body whose first line is the wrong gate's marker. */
export class VerdictInputError extends Schema.TaggedErrorClass<VerdictInputError>()(
	"@kampus/verdict/VerdictInputError",
	{
		message: Schema.String,
	},
) {}

/** The `read` verdict — the resolved outcome plus the head it was resolved against. */
export interface ReadResult {
	readonly outcome: VerdictOutcome;
	readonly headSha: string;
	readonly gate: VerdictGate;
	/** Does the outcome satisfy the caller's expected polarity (a current-head match)? */
	readonly satisfied: boolean;
	readonly expect: Polarity;
}

/** The `post` verdict — whether we upserted an existing marker or posted the first one, and the comment id. */
export interface PostResult {
	readonly _tag: "patched" | "posted";
	readonly commentId: number;
}

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

/**
 * Run `gh <args>` and return stdout, failing `GhCommandError` on a non-zero exit — the same
 * direct-spawn shape `epic-lock` uses so a non-zero exit + stderr lower into a typed error
 * rather than a throw. A spawn/IO `PlatformError` (e.g. `gh` not on PATH) folds in as exit `-1`.
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
 * `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` (CI) → `gh repo view`. Never silently defaults —
 * with no env and no resolvable current repo it fails `RepoResolutionError`.
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
		Effect.catchTag("@kampus/verdict/GhCommandError", () => Effect.succeed("")),
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

const headShaArgs = (repo: string, pr: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/pulls/${pr}`,
	"--jq",
	".head.sha",
];

const listCommentsArgs = (repo: string, pr: number): ReadonlyArray<string> => [
	"api",
	"--paginate",
	`repos/${repo}/issues/${pr}/comments?per_page=100`,
];

const whoAmIArgs: ReadonlyArray<string> = ["api", "user", "--jq", ".login"];

const permissionArgs = (repo: string, login: string): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/collaborators/${login}/permission`,
	"--jq",
	".permission",
];

const postCommentArgs = (repo: string, pr: number, body: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"POST",
	`repos/${repo}/issues/${pr}/comments`,
	"-f",
	`body=${body}`,
	"--jq",
	".id",
];

const patchCommentArgs = (repo: string, id: number, body: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"PATCH",
	`repos/${repo}/issues/comments/${id}`,
	"-f",
	`body=${body}`,
	"--jq",
	".id",
];

/** A raw comment as the issues/comments endpoint returns it; only these fields are read. */
const RawComment = Schema.Struct({
	id: Schema.Number,
	created_at: Schema.String,
	body: Schema.optionalKey(Schema.NullOr(Schema.String)),
	user: Schema.NullOr(Schema.Struct({login: Schema.String})),
});
const decodeComments = Schema.decodeUnknownEffect(Schema.Array(RawComment));

const toVerdictComment = (raw: (typeof RawComment)["Type"]): VerdictComment => ({
	id: raw.id,
	author: raw.user?.login ?? "",
	createdAt: raw.created_at,
	body: raw.body ?? "",
});

const currentHead = Effect.fn("Github.currentHead")(function* (repo: string, pr: number) {
	return (yield* runGh(headShaArgs(repo, pr))).trim();
});

const listComments = Effect.fn("Github.listComments")(function* (repo: string, pr: number) {
	const args = listCommentsArgs(repo, pr);
	const raw = yield* decodeComments(yield* json(args));
	return raw.map(toVerdictComment);
});

/**
 * The write+ collaborator subset of `logins` — the ADR 0055 trust root. Each login is probed
 * with `collaborators/<login>/permission`; a non-`admin|maintain|write` permission, or any `gh`
 * fault on the probe (a non-collaborator commonly 404s), drops the login. A forged marker from a
 * non-collaborator therefore never enters the authorized set the core resolves over.
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
				Effect.catchTag("@kampus/verdict/GhCommandError", () =>
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
 * Read the PR's verdict for `gate` against its current head (or `headOverride` when the caller
 * already resolved it — e.g. a reviewer binding to the exact head it read). Author-gates the
 * distinct marker authors to write+ collaborators, then runs the pure `resolveVerdict`.
 */
const read = Effect.fn("Github.read")(function* (
	repo: string,
	pr: number,
	gate: VerdictGate,
	expect: Polarity,
	headOverride: string | undefined,
) {
	const headSha = headOverride?.trim() || (yield* currentHead(repo, pr));
	const comments = yield* listComments(repo, pr);
	const re = namespaceRe(gate);
	const markerAuthors = [
		...new Set(
			comments
				.filter((c) => re.test(c.body))
				.map((c) => c.author)
				.filter((a) => a.length > 0),
		),
	];
	const authorized = yield* authorizedAuthors(repo, markerAuthors);
	const outcome = resolveVerdict({comments, authorizedAuthors: authorized, gate, headSha});
	const satisfied = outcome._tag === "current" && outcome.polarity === expect;
	return {outcome, headSha, gate, satisfied, expect} satisfies ReadResult;
});

/**
 * Upsert this PR's `gate` verdict (ADR 0058 rule 2). Three fail-closed emission guards run first:
 * the body's first line must be *this* gate's marker (rejects a cross-namespace body); a
 * polarity-bearing (PASS/FAIL) body must carry a well-formed `@ <sha>` (rejects the unbindable
 * empty-SHA `@-` marker the read side refuses, #2646); and every SHA field it carries — the
 * first-line `@ <sha>` and the §CP advisory `Reviewed-head:` anchor — must be a clean full 40-hex,
 * not a partial/non-hex/path-glued value (rejects the `mktemp`-path leak of #2683). An advisory
 * SHA-less first line stays postable. Then scan our OWN prior marker in the namespace (newest by
 * `(created_at, id)`) and PATCH it if present else POST a fresh one. The own-authored scope means
 * two reviewers never stomp each other's records.
 */
const post = Effect.fn("Github.post")(function* (
	repo: string,
	pr: number,
	gate: VerdictGate,
	body: string,
) {
	const defect = emissionDefect(body, gate);
	if (defect !== null) {
		return yield* new VerdictInputError({message: `refusing to post: ${defect}`});
	}
	const me = (yield* runGh(whoAmIArgs)).trim();
	const comments = yield* listComments(repo, pr);
	const re = namespaceRe(gate);
	const mine = comments
		.filter((c) => c.author === me && re.test(c.body))
		.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id));
	const priorId = mine[mine.length - 1]?.id;
	if (priorId !== undefined) {
		const decoded = yield* json(patchCommentArgs(repo, priorId, body));
		return {
			_tag: "patched",
			commentId: typeof decoded === "number" ? decoded : priorId,
		} satisfies PostResult;
	}
	const decoded = yield* json(postCommentArgs(repo, pr, body));
	if (typeof decoded !== "number") {
		return yield* new GhParseError({
			args: postCommentArgs(repo, pr, "<body>"),
			message: "comment POST did not return a numeric id",
		});
	}
	return {_tag: "posted", commentId: decoded} satisfies PostResult;
});

/**
 * `Github` — the IO shell over `gh api` REST for the ADR-0058 verdict read/post glue. `read`
 * resolves a (PR, gate) verdict against the current head; `post` upserts a SHA-bound verdict
 * comment. Built by `GithubLive`, whose `R` is `ChildProcessSpawner`.
 */
export class Github extends Context.Service<
	Github,
	{
		readonly read: (
			pr: number,
			gate: VerdictGate,
			expect: Polarity,
			headOverride?: string,
		) => Effect.Effect<
			ReadResult,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
		readonly post: (
			pr: number,
			gate: VerdictGate,
			body: string,
		) => Effect.Effect<
			PostResult,
			RepoResolutionError | GhCommandError | GhParseError | VerdictInputError | Schema.SchemaError
		>;
	}
>()("@kampus/verdict/Github") {}

/**
 * The live `Github` layer. The `ChildProcessSpawner` dependency is captured once at construction
 * and provided into each method body, so the public methods carry `R = never`. Repo resolution is
 * deferred to first use (`Effect.cached`, ADR 0062 §1): the layer build is side-effect-free, and
 * `RepoResolutionError` lives in each method's `E` channel, raised only when a verb actually reads or writes.
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
				read: (pr, gate, expect, headOverride) =>
					repo.pipe(Effect.flatMap((r) => withSpawner(read(r, pr, gate, expect, headOverride)))),
				post: (pr, gate, body) =>
					repo.pipe(Effect.flatMap((r) => withSpawner(post(r, pr, gate, body)))),
			};
		}),
	);
