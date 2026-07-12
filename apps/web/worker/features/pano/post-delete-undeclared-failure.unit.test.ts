/**
 * `post.delete` has no undeclared failure channel (#1639).
 *
 * The mutation declared only `Unauthorized | UnauthorizedPostMutation`, but its
 * removal commit runs over `DrizzleAccessOrDie` — a D1-layer write failure *dies*,
 * and a defect is not a member of that union, so it escaped the handler as a raw
 * `INTERNAL_SERVER_ERROR` (the squashed-defect wire code, `WireError.ts`). Two
 * regressions pin the closure:
 *
 *   (a) WIRE boundary — driven through `resolveWire` (`resolve` decode +
 *       `encodeWireError` class→wire-code, the same seams `/fate` crosses):
 *         - own-post delete → success (the id-only eviction ref, never a 500);
 *         - missing / already-removed post → success (the graceful `deleted:false`);
 *         - a removal-commit *die* → the DECLARED, annotated `POST_DELETE_FAILED`,
 *           NOT `INTERNAL_SERVER_ERROR`. Without the handler's `catchDefect` this
 *           asserts `INTERNAL_SERVER_ERROR` and fails.
 *
 *   (b) SERVICE — the post-commit stats refresh is a recomputable cache (ADR
 *       0011/0117): a refresh die must NOT flip an already-committed removal into a
 *       failure (the partial-commit-then-500). Driven over a scripted `Drizzle`
 *       whose stamp batch commits but whose later stats `run` dies.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Cause, type Context, Effect, Exit, Layer} from "effect";
import {Drizzle, type DrizzleAccess} from "../../db/Drizzle.ts";
import {UserId} from "../../lib/ids.ts";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {PasaportIdentityStub} from "../pasaport/Pasaport.testing.ts";
import {ReactionStub} from "../reaction/Reaction.testing.ts";
import {Vote} from "../vote/Vote.ts";
import {Bookmark} from "./Bookmark.ts";
import {PostId} from "./ids.ts";
import {mutations} from "./mutations.ts";
import {Pano, PanoLive} from "./Pano.ts";

const AUTHOR = {id: "u-author", email: "elif@example.com", name: "elif"};

const runtimeContextStub: BaseRuntimeContext = {
	Type: "test",
	id: "test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

// Fire-and-forget publish (error channel `never`); it can never fail the mutation.
const liveStub = Layer.succeed(LivePublisher)(
	livePublisherFor({publish: () => Effect.void, waitUntil: () => {}}),
);

// A `Pano` stub whose `deletePost` is scripted; every other method dies loud — the
// handler path only ever reaches `deletePost`.
const panoStub = (deletePost: (typeof Pano.Service)["deletePost"]): Layer.Layer<Pano> =>
	Layer.succeed(
		Pano,
		new Proxy({deletePost} as Partial<typeof Pano.Service>, {
			get(target, prop) {
				if (prop in target) return (target as Record<string, unknown>)[prop as string];
				return () => Effect.die(`Pano.${String(prop)} not exercised in post-delete regression`);
			},
		}) as typeof Pano.Service,
	);

const deleteWire = (pano: Layer.Layer<Pano>) =>
	resolveWire(mutations["post.delete"], {input: {id: "post_1"}, select: ["id"]}).pipe(
		Effect.provide(Layer.mergeAll(pano, liveStub)),
		Effect.provideService(CurrentUser, {user: AUTHOR}),
		Effect.provideService(RuntimeContext, runtimeContextStub),
	);

describe("post.delete — (a) no undeclared failure channel at the wire boundary", () => {
	it.effect("own-post delete succeeds with the id-only eviction ref (never a 500)", () =>
		Effect.gen(function* () {
			const result = yield* deleteWire(
				panoStub(() => Effect.succeed({postId: "post_1", deleted: true})),
			);
			assert.strictEqual((result as {id?: string}).id, "post_1");
		}),
	);

	it.effect("a missing / already-removed post deletes gracefully (never a 500)", () =>
		Effect.gen(function* () {
			const result = yield* deleteWire(
				panoStub(() => Effect.succeed({postId: "post_1", deleted: false})),
			);
			assert.strictEqual((result as {id?: string}).id, "post_1");
		}),
	);

	it.effect(
		"a removal-commit die surfaces the typed POST_DELETE_FAILED, not INTERNAL_SERVER_ERROR",
		() =>
			Effect.gen(function* () {
				const exit = yield* Effect.exit(
					deleteWire(panoStub(() => Effect.die(new Error("D1 removal-commit write failed")))),
				);
				assert.isTrue(Exit.isFailure(exit), "a removal-commit failure must surface, not vanish");
				if (Exit.isFailure(exit)) {
					const error = Cause.findErrorOption(exit.cause);
					assert.isTrue(error._tag === "Some", "expected a typed wire failure, not a bare defect");
					if (error._tag === "Some") {
						assert.strictEqual((error.value as {code?: string}).code, "POST_DELETE_FAILED");
					}
				}
			}),
	);
});

// The stamp batch commits (source of truth), then the post-commit stats refresh dies.
const ownerId = UserId.make(AUTHOR.id);
const removalCommitsThenStatsDie = (): DrizzleAccess => {
	let runs = 0;
	return {
		run: <A>(_fn: unknown) => {
			runs++;
			// run #1 = the meta findFirst (owned, live row); run #2+ = persistPanoStats.
			if (runs === 1) {
				return Effect.succeed({
					id: "post_1",
					authorId: ownerId,
					removedAt: null,
					removedBy: null,
					removedReason: null,
					sandboxedAt: null,
				} as A);
			}
			return Effect.die(
				new Error("pano-stats refresh must be swallowed once the removal has committed"),
			);
		},
		batch: () => Effect.succeed(undefined as never),
	} as DrizzleAccess;
};

// `Vote.clearTarget` is the only Vote method `removeEntity` reaches; succeed inertly.
// Every other method dies loud (mirrors `panoStub`), so an unexpected call is caught.
const voteStub = Layer.succeed(
	Vote,
	new Proxy({clearTarget: () => Effect.void} as Partial<Context.Service.Shape<typeof Vote>>, {
		get(target, prop) {
			if (prop in target) return (target as Record<string, unknown>)[prop as string];
			return () => Effect.die(`Vote.${String(prop)} not exercised in post-delete regression`);
		},
	}) as Context.Service.Shape<typeof Vote>,
);
const inertBookmark = Layer.succeed(Bookmark, {} as Context.Service.Shape<typeof Bookmark>);

const panoServiceLayer = (access: DrizzleAccess) =>
	PanoLive.pipe(
		Layer.provide(Layer.succeed(Drizzle, access)),
		Layer.provide(voteStub),
		Layer.provide(inertBookmark),
		Layer.provide(ReactionStub),
		Layer.provide(PasaportIdentityStub),
	);

describe("post.delete — (b) a post-commit cache refresh cannot fail a committed removal", () => {
	it.effect("a stats-refresh die after the removal commits still returns deleted:true", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.gen(function* () {
				const pano = yield* Pano;
				return yield* pano
					.deletePost({postId: PostId.make("post_1"), actorId: ownerId})
					.pipe(Effect.exit);
			}).pipe(Effect.provide(panoServiceLayer(removalCommitsThenStatsDie())));
			assert.isTrue(
				Exit.isSuccess(exit),
				"removal committed → the delete must succeed despite a recomputable-cache refresh die",
			);
			if (Exit.isSuccess(exit)) {
				assert.strictEqual(exit.value.postId, "post_1");
				assert.strictEqual(exit.value.deleted, true);
			}
		}),
	);
});
