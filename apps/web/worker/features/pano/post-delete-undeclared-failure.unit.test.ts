/**
 * `post.delete` has no undeclared failure channel (#1639). Its removal commit runs over
 * `DrizzleAccessOrDie`, so a D1 write failure DIES — and a defect is in no declared
 * error union, so it used to escape as a raw `INTERNAL_SERVER_ERROR`. Two regressions
 * pin the closure: (a) a removal-commit die must reach the wire as the declared
 * `POST_DELETE_FAILED`; (b) a post-commit stats-refresh die must not flip an
 * already-committed removal into a failure (ADR 0011/0117 — a recomputable cache).
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

const liveStub = Layer.succeed(LivePublisher)(
	livePublisherFor({publish: () => Effect.void, waitUntil: () => {}}),
);

// Every method but `deletePost` dies loud, so an unexpected call is caught.
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

// `clearTarget` is the only Vote method `removeEntity` reaches; the rest die loud.
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
