/**
 * Create-path partial-failure guard (#2556, the create twin of #2012). A create's
 * post-commit cache refresh is a recomputable cache (ADR 0011/0117), so a die there must
 * NOT flip an already-committed insert into a raw 500: the id is minted server-side per
 * call, so a caller that retries the 500 (agent clients retry mechanically) mints a SECOND
 * row — a duplicate that reads as user intent. Both create paths — sözlük `addDefinition`
 * and pano `submitPost` — route their post-commit refresh through the shared
 * `swallowRefresh` ceremony, so a refresh die returns success and no retry (hence no
 * duplicate) is provoked.
 *
 * Driven at the SERVICE seam over a scripted `Drizzle` whose commit lands but whose
 * post-commit refresh dies (the same shape as `post-delete-undeclared-failure` part b).
 * The teeth: a client that retries on failure is modeled explicitly and the committed-row
 * counter is asserted to stay at 1 — without the swallow the first attempt would 500, the
 * client would retry, and the counter would climb past 1 (the duplicate).
 */
import {assert, describe, it} from "@effect/vitest";
import {type Context, Effect, Exit, Layer} from "effect";
import {Drizzle, type DrizzleAccess, DrizzleError} from "../../db/Drizzle.ts";
import {TermSlug, UserId} from "../../lib/ids.ts";
import {Bookmark} from "../pano/Bookmark.ts";
import {Pano, PanoLive} from "../pano/Pano.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";
import {Reaction} from "../reaction/Reaction.ts";
import {Sozluk, SozlukLive} from "../sozluk/Sozluk.ts";
import {Vote} from "../vote/Vote.ts";

// A refresh over the raw `Drizzle` fails with `DrizzleError`, which `orDieAccess` collapses
// to a die inside the feature service — the exact channel `swallowRefresh` must absorb.
const refreshDies = <A>(): Effect.Effect<A, DrizzleError> =>
	Effect.fail(new DrizzleError({cause: new Error("post-commit cache refresh dies")}));

// Sözlük `addDefinition` reaches the DB as: run#1 existing-term lookup → run#2 the
// `definitionRecord` insert (the commit) → run#3+ the `persistTermSummary` /
// `recomputeSozlukStats` refresh. Fresh per attempt so the order counter resets; the shared
// `onCommit` accumulates committed rows across a client's retries.
const sozlukCommitThenRefreshDies = (onCommit: () => void): DrizzleAccess => {
	let runs = 0;
	return {
		run: <A>(_fn: unknown) => {
			runs += 1;
			if (runs === 1) return Effect.succeed(undefined as A);
			if (runs === 2) {
				onCommit();
				return Effect.succeed(undefined as A);
			}
			return refreshDies<A>();
		},
		batch: () => refreshDies<never>(),
	} as DrizzleAccess;
};

// Pano `submitPost` commits through its only `batch` (the `postRecord` insert + `post_search`
// dual-write) and refreshes through `persistPanoStats`' `run` — so method alone discriminates
// commit from refresh, no order counter needed.
const panoCommitThenRefreshDies = (onCommit: () => void): DrizzleAccess =>
	({
		run: () => refreshDies<never>(),
		batch: () => {
			onCommit();
			return Effect.succeed(undefined as never);
		},
	}) as DrizzleAccess;

const inertVote = Layer.succeed(Vote, {} as Context.Service.Shape<typeof Vote>);
const inertBookmark = Layer.succeed(Bookmark, {} as Context.Service.Shape<typeof Bookmark>);
const inertReaction = Layer.succeed(Reaction, {} as Context.Service.Shape<typeof Reaction>);
const inertPasaport = Layer.succeed(Pasaport, {} as Context.Service.Shape<typeof Pasaport>);

const sozlukLayer = (access: DrizzleAccess) =>
	SozlukLive.pipe(
		Layer.provide(Layer.succeed(Drizzle, access)),
		Layer.provide(inertVote),
		Layer.provide(inertReaction),
		Layer.provide(inertPasaport),
	);

const panoLayer = (access: DrizzleAccess) =>
	PanoLive.pipe(
		Layer.provide(Layer.succeed(Drizzle, access)),
		Layer.provide(inertVote),
		Layer.provide(inertBookmark),
		Layer.provide(inertReaction),
		Layer.provide(inertPasaport),
	);

// A caller that retries a failed create up to `maxAttempts` (an agent client's mechanical
// retry), returning the first success or the last failure.
const clientRetries = <A, E>(
	attempt: () => Effect.Effect<A, E>,
	maxAttempts: number,
): Effect.Effect<Exit.Exit<A, E>> =>
	Effect.gen(function* () {
		let last!: Exit.Exit<A, E>;
		for (let i = 0; i < maxAttempts; i += 1) {
			last = yield* Effect.exit(attempt());
			if (Exit.isSuccess(last)) break;
		}
		return last;
	});

describe("addDefinition — a post-commit refresh die cannot 500 a committed insert (#2556)", () => {
	it.effect("returns success, and a retrying client mints exactly one definition row", () =>
		Effect.gen(function* () {
			let committed = 0;
			const attempt = () =>
				Effect.gen(function* () {
					const sozluk = yield* Sozluk;
					return yield* sozluk.addDefinition({
						termSlug: TermSlug.make("x"),
						termTitle: "X",
						authorId: UserId.make("a1"),
						authorName: "n",
						body: "a valid definition body",
					});
				}).pipe(
					Effect.provide(
						sozlukLayer(
							sozlukCommitThenRefreshDies(() => {
								committed += 1;
							}),
						),
					),
				);

			const exit = yield* clientRetries(attempt, 3);
			assert.isTrue(
				Exit.isSuccess(exit),
				"a refresh die after the definition insert commits must still succeed",
			);
			if (Exit.isSuccess(exit)) {
				assert.isString(exit.value.definitionId);
				assert.strictEqual(exit.value.termCreated, true);
			}
			assert.strictEqual(
				committed,
				1,
				"the create succeeded first try → no retry → exactly one row (no duplicate)",
			);
		}),
	);
});

describe("submitPost — a post-commit refresh die cannot 500 a committed insert (#2556)", () => {
	it.effect("returns success, and a retrying client mints exactly one post row", () =>
		Effect.gen(function* () {
			let committed = 0;
			const attempt = () =>
				Effect.gen(function* () {
					const pano = yield* Pano;
					return yield* pano.submitPost({
						title: "geçerli başlık",
						body: "gövde",
						url: undefined,
						tags: [{kind: "soru"}],
						authorId: "u1",
						authorName: "umut",
					});
				}).pipe(
					Effect.provide(
						panoLayer(
							panoCommitThenRefreshDies(() => {
								committed += 1;
							}),
						),
					),
				);

			const exit = yield* clientRetries(attempt, 3);
			assert.isTrue(
				Exit.isSuccess(exit),
				"a refresh die after the post insert commits must still succeed",
			);
			if (Exit.isSuccess(exit)) {
				assert.isString(exit.value.postId);
			}
			assert.strictEqual(
				committed,
				1,
				"the create succeeded first try → no retry → exactly one row (no duplicate)",
			);
		}),
	);
});
