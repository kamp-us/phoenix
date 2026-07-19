/**
 * The GitHub + git boundary for `review-head`: the live `ReviewHead` capability that resolves and
 * materializes a PR's current review head deterministically over `gh api` REST + `git`, driving the
 * IO-free `resolve-head.ts` core. The single owner of the "materialize the PR head for review" step
 * the review-code / review-doc / review-skill gates each hand-copied inline (#793 / #1807), and the
 * head-SHA resolution review-design binds its verdict to.
 *
 * Two verbs, sharing the `resolveHead` core:
 *  - `resolve(pr)` — REST-only: the current head SHA + ref, fail-safe on a missing/closed PR. What
 *    review-design needs (it reviews a preview URL, not a checked-out tree).
 *  - `materialize(pr, {worktree})` — the §HEAD read path: resolve, then fetch `pull/<pr>/head` into a
 *    per-run ref (never the launched tree), assert the fetched ref IS the resolved head SHA, and —
 *    with `--worktree` — add a throwaway DETACHED worktree on that ref (never a branch switch, §RO).
 *
 * REST only (GraphQL is broken on the kamp-us org); every infra failure is a typed error. The caller
 * is responsible for the §RO-iso primary-checkout preflight BEFORE calling `materialize` — this verb
 * is the deterministic mechanism, not the isolation gate.
 */
import {randomUUID} from "node:crypto";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Context, Effect, Layer} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcessSpawner} from "effect/unstable/process";
import {
	type GhCommandError,
	type GhParseError,
	json,
	type RepoResolutionError,
	resolveRepo,
} from "../tracker/gh-io.ts";
import {type GitCommandError, runGit} from "./git-io.ts";
import {
	type MaterializePlan,
	type PullHeadPayload,
	planMaterialization,
	type ResolvedHead,
	resolveHead,
} from "./resolve-head.ts";

/** The PR could not be resolved to a bindable head (missing/closed PR, deleted/partial head SHA). */
export class UnresolvableHeadError extends Schema.TaggedErrorClass<UnresolvableHeadError>()(
	"@kampus/review-head/UnresolvableHeadError",
	{message: Schema.String},
) {}

/** The fetched per-run ref did not resolve to the head SHA REST reported — a moved/raced head; abort rather than review the wrong tree. */
export class HeadMismatchError extends Schema.TaggedErrorClass<HeadMismatchError>()(
	"@kampus/review-head/HeadMismatchError",
	{message: Schema.String},
) {}

export {GitCommandError} from "./git-io.ts";

/** The result of a `materialize` — the resolved head plus the per-run ref (and worktree, when requested). */
export interface MaterializeResult {
	readonly pr: number;
	readonly headSha: string;
	readonly headRef: string;
	readonly crossFork: boolean;
	readonly prRef: string;
	/** The throwaway detached worktree path, or `null` for a ref-only materialization. */
	readonly worktreeDir: string | null;
}

// Only the fields review-head reads; head/head.repo are NullOr for a deleted head / deleted fork.
const RawPull = Schema.Struct({
	number: Schema.Number,
	state: Schema.String,
	head: Schema.NullOr(
		Schema.Struct({
			sha: Schema.NullOr(Schema.String),
			ref: Schema.NullOr(Schema.String),
			repo: Schema.NullOr(Schema.Struct({full_name: Schema.String})),
		}),
	),
	base: Schema.Struct({repo: Schema.Struct({full_name: Schema.String})}),
});
const decodePull = Schema.decodeUnknownEffect(RawPull);

const toPayload = (raw: (typeof RawPull)["Type"]): PullHeadPayload => ({
	number: raw.number,
	state: raw.state,
	head:
		raw.head === null
			? null
			: {
					sha: raw.head.sha,
					ref: raw.head.ref,
					repoFullName: raw.head.repo?.full_name ?? null,
				},
	baseRepoFullName: raw.base.repo.full_name,
});

const pullArgs = (repo: string, pr: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/pulls/${pr}`,
];

/** REST-resolve the PR's current head, decode it, and run the pure `resolveHead` — the shared front half of both verbs. */
const resolve = Effect.fn("ReviewHead.resolve")(function* (repo: string, pr: number) {
	const raw = yield* decodePull(yield* json(pullArgs(repo, pr)));
	const resolution = resolveHead(toPayload(raw));
	if (resolution._tag === "unresolvable") {
		return yield* new UnresolvableHeadError({message: resolution.reason});
	}
	return resolution satisfies ResolvedHead;
});

/**
 * Materialize the head per the plan: fetch `pull/<pr>/head` into the per-run ref (the head reaches a
 * ref, never the launched working tree — §RO), assert the fetched ref IS the resolved head SHA (a
 * moved head between resolve and fetch aborts rather than reviewing a stale tree — §HEAD #2), then —
 * when `worktree` — `git worktree add --detach` a throwaway tree on that ref. Detached by construction
 * (the `resolve-head` plan's `detach: true`): never `git checkout <headRef>`, safe for cross-fork heads.
 */
const materialize = Effect.fn("ReviewHead.materialize")(function* (
	repo: string,
	pr: number,
	worktree: boolean,
) {
	const head = yield* resolve(repo, pr);
	const plan: MaterializePlan = planMaterialization(head, {pr, nonce: randomUUID()});

	yield* runGit(["fetch", "origin", plan.fetchRefspec]);
	const fetched = (yield* runGit(["rev-parse", plan.prRef])).trim().toLowerCase();
	if (fetched !== plan.headSha) {
		return yield* new HeadMismatchError({
			message: `fetched head ${fetched} != resolved ${plan.headSha} for PR #${pr} — the head moved under the review; aborting rather than binding a verdict to a tree I did not fetch (§HEAD #2)`,
		});
	}

	let worktreeDir: string | null = null;
	if (worktree) {
		worktreeDir = mkdtempSync(join(tmpdir(), `review-head-${pr}-`));
		yield* runGit(["worktree", "add", "--detach", worktreeDir, plan.prRef]);
	}

	return {
		pr,
		headSha: plan.headSha,
		headRef: plan.headRef,
		crossFork: plan.crossFork,
		prRef: plan.prRef,
		worktreeDir,
	} satisfies MaterializeResult;
});

/**
 * `ReviewHead` — the IO shell over `gh api` REST + `git` for the §HEAD head materialization.
 * `resolve` gives the current head SHA/ref (review-design); `materialize` fetches it into a per-run
 * ref and optionally a detached throwaway worktree (review-code/doc/skill). Built by `ReviewHeadLive`.
 */
export class ReviewHead extends Context.Service<
	ReviewHead,
	{
		readonly resolve: (
			pr: number,
		) => Effect.Effect<
			ResolvedHead,
			| RepoResolutionError
			| GhCommandError
			| GhParseError
			| UnresolvableHeadError
			| Schema.SchemaError
		>;
		readonly materialize: (
			pr: number,
			worktree: boolean,
		) => Effect.Effect<
			MaterializeResult,
			| RepoResolutionError
			| GhCommandError
			| GhParseError
			| GitCommandError
			| UnresolvableHeadError
			| HeadMismatchError
			| Schema.SchemaError
		>;
	}
>()("@kampus/review-head/ReviewHead") {}

/**
 * The live `ReviewHead` layer. The `ChildProcessSpawner` dependency is captured once and provided
 * into each method body (public methods carry `R = never`); repo resolution is deferred to first use
 * (`Effect.cached`, ADR 0062 §1) so the layer build is side-effect-free.
 */
export const ReviewHeadLive: Layer.Layer<
	ReviewHead,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(ReviewHead)(
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const withSpawner = <A, E>(
			effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
		) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
		const repo = yield* Effect.cached(withSpawner(resolveRepo()));
		return {
			resolve: (pr) => repo.pipe(Effect.flatMap((r) => withSpawner(resolve(r, pr)))),
			materialize: (pr, worktree) =>
				repo.pipe(Effect.flatMap((r) => withSpawner(materialize(r, pr, worktree)))),
		};
	}),
);
