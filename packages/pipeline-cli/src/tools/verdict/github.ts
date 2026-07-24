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
import {Context, Effect, Layer} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcessSpawner} from "effect/unstable/process";
// The `gh api` REST IO seam (runGh / resolveRepo / authorizedAuthors / RawComment) is the SINGLE
// SOURCE shared with the `Tracker` service and `epic-lock` — no longer re-copied here (#3262 AC 5).
// The error types are re-exported below so callers/tests keep importing them from this module.
import {
	authorizedAuthors,
	decodeComments,
	type GhCommandError,
	GhParseError,
	getCommentBodyArgs,
	json,
	listCommentsArgs,
	patchCommentArgs,
	postCommentArgs,
	type RawComment,
	type RepoResolutionError,
	resolveRepo,
	runGh,
	whoAmIArgs,
} from "../tracker/gh-io.ts";
import {
	boundHeadShas,
	emissionDefect,
	headBindingDefect,
	namespaceRe,
	type Polarity,
	resolveVerdict,
	type VerdictComment,
	type VerdictGate,
	type VerdictOutcome,
} from "./verdict-match.ts";

// Re-export the shared IO seam's typed failures so callers/tests keep importing them from this
// module — the single-source classes now live in `../tracker/gh-io.ts` (#3262 AC 5).
export {GhCommandError, GhParseError, RepoResolutionError} from "../tracker/gh-io.ts";

/** A malformed request the caller must fix — e.g. a `post` body whose first line is the wrong gate's marker. */
export class VerdictInputError extends Schema.TaggedErrorClass<VerdictInputError>()(
	"@kampus/verdict/VerdictInputError",
	{
		message: Schema.String,
	},
) {}

/**
 * The verdict body binds a head SHA that is not the target PR's current head — the post-time
 * cross-check (#3801). A body composed for PR B (bound to B's head) that is POSTed to PR A carries
 * B's SHA, which does not match A's live head, so the post is refused rather than publishing a
 * well-formed marker bound to the WRONG PR (the cross-PR scratchpad-clobber verdict-integrity hole).
 * The caller re-reviews the current head and re-composes. Distinct from `VerdictInputError` (a
 * malformed body) — the body is well-formed, its binding is just stale/foreign.
 */
export class VerdictHeadMismatchError extends Schema.TaggedErrorClass<VerdictHeadMismatchError>()(
	"@kampus/verdict/VerdictHeadMismatchError",
	{
		message: Schema.String,
	},
) {}

/**
 * The LANDED verdict comment failed its post-write self-verify: after `post` wrote the comment it
 * re-fetched it and the landed body is not a clean, in-namespace marker (a `@path`/non-marker first
 * line, or a machine-local path anywhere in the body). This is the defense-in-depth read-back folded
 * INTO `post` so the "called `post` but skipped the separate verify line" gap can't leak a bad
 * marker (issue #3019). Non-recoverable: the tool exits non-zero rather than report a false success.
 */
export class VerdictVerifyError extends Schema.TaggedErrorClass<VerdictVerifyError>()(
	"@kampus/verdict/VerdictVerifyError",
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

// The PR head-SHA read is the one arg builder unique to `verdict` (the ADR-0058 head binding);
// the generic comment IO (list/post/patch/get-body) and the `whoami` probe are the shared
// `../tracker/gh-io.ts` seam.
const headShaArgs = (repo: string, pr: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/pulls/${pr}`,
	"--jq",
	".head.sha",
];

const toVerdictComment = (raw: (typeof RawComment)["Type"]): VerdictComment => ({
	id: raw.id,
	author: raw.user?.login ?? "",
	createdAt: raw.created_at,
	body: raw.body ?? "",
});

const currentHead = Effect.fn("Github.currentHead")(function* (repo: string, pr: number) {
	return (yield* runGh(headShaArgs(repo, pr))).trim();
});

/**
 * The post self-verify (#3019): re-fetch the comment `post` just upserted and assert its LANDED body
 * passes the SAME `emissionDefect` gate the input passed — a marker on line one, a bindable `@ <sha>`,
 * and no machine-local path anywhere. This is the read-back folded INTO `post` so a caller who calls
 * `post` but skips the separate `validate`/read-back line still can't leave a `@path`/non-marker/leaking
 * comment on a public PR reporting success. A failed re-fetch (a missing/deleted comment) is itself a
 * verify failure. Fail-closed: only a clean landed body returns; anything else raises VerdictVerifyError.
 */
const verifyLanded = Effect.fn("Github.verifyLanded")(function* (
	repo: string,
	id: number,
	gate: VerdictGate,
) {
	const landed = yield* runGh(getCommentBodyArgs(repo, id)).pipe(
		Effect.catchTag(
			"@kampus/gh-io/GhCommandError",
			(cause) =>
				new VerdictVerifyError({
					message: `could not re-fetch the just-posted verdict comment #${id} to self-verify it (${cause.stderr.trim() || `exit ${cause.exitCode}`}) — refusing to report success on an unverifiable post (#3019)`,
				}),
		),
	);
	const defect = emissionDefect(landed, gate);
	if (defect !== null) {
		return yield* new VerdictVerifyError({
			message: `the LANDED verdict comment #${id} failed self-verify: ${defect} — a bypassed/hand-rolled body reached GitHub; the post is rejected rather than reported as success (#3019)`,
		});
	}
});

const listComments = Effect.fn("Github.listComments")(function* (repo: string, pr: number) {
	const args = listCommentsArgs(repo, pr);
	const raw = yield* decodeComments(yield* json(args));
	return raw.map(toVerdictComment);
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
 * SHA-less first line stays postable. Then, when the body binds any head SHA, the post-time
 * cross-check (#3801) fetches the target PR's live head and refuses if a bound SHA does not match it
 * — closing the verdict-integrity hole where a body composed for another PR (bound to a different
 * PR's SHA, e.g. via a clobbered shared scratch file) was postable and caught only on read-back.
 * Then scan our OWN prior marker in the namespace (newest by
 * `(created_at, id)`) and PATCH it if present else POST a fresh one. The own-authored scope means
 * two reviewers never stomp each other's records. Finally, `verifyLanded` re-fetches the upserted
 * comment and re-runs `emissionDefect` on its LANDED body — the defense-in-depth self-verify (#3019)
 * that fails the post if the marker didn't land clean, rather than reporting a false success.
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
	// Post-time head cross-check (#3801): only when the body actually binds a SHA — a SHA-less
	// advisory binds nothing, so it needs no live-head lookup and stays postable. When it does bind,
	// the marker's SHA must be THIS PR's current head, not another PR's (the cross-PR clobber).
	if (boundHeadShas(body, gate).length > 0) {
		const head = yield* currentHead(repo, pr);
		const mismatch = headBindingDefect(body, gate, head);
		if (mismatch !== null) {
			return yield* new VerdictHeadMismatchError({message: `refusing to post: ${mismatch}`});
		}
	}
	const me = (yield* runGh(whoAmIArgs)).trim();
	const comments = yield* listComments(repo, pr);
	const re = namespaceRe(gate);
	const mine = comments
		.filter((c) => c.author === me && re.test(c.body))
		.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id));
	const priorId = mine[mine.length - 1]?.id;
	const result: PostResult = yield* Effect.gen(function* () {
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
	yield* verifyLanded(repo, result.commentId, gate);
	return result;
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
			| RepoResolutionError
			| GhCommandError
			| GhParseError
			| VerdictInputError
			| VerdictHeadMismatchError
			| VerdictVerifyError
			| Schema.SchemaError
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
