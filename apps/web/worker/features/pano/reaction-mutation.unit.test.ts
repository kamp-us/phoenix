/**
 * `post.react` wire-boundary unit coverage (#1863, epic #1840) — the mutation WIRING only,
 * driven through its real external interface (`resolveWire`), so a decode rejection surfaces as a
 * wire `code`. The `Pano` / `Flags` / `LivePublisher` seams are substituted: no DB, no Flagship.
 *
 * The react/change/retract write semantics live over the real service in
 * `../reaction/Reaction.unit.test.ts` (#1861). The four describe blocks below are the four ACs.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Cause, Effect, Layer} from "effect";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {Flags} from "../flagship/Flags.ts";
import {inPlaceVisibilityStores, moderatorAxisLayer} from "../kunye/sandbox.testing.ts";
import {EMPTY_REACTION_AGGREGATE, type ReactionAggregate} from "../reaction/Reaction.ts";
import {mutations} from "./mutations.ts";
import {Pano, type PostSummaryRow, type ReactToPostResult} from "./Pano.ts";

const CAYLAK = {id: "u-caylak", email: "yeni@example.com", name: "yeni"};

const runtimeContextStub: BaseRuntimeContext = {
	Type: "test",
	id: "test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

// `getBoolean` returns a fixed value; every other typed read dies so a stray call is loud.
const flagsStub = (value: boolean): Layer.Layer<Flags> =>
	Layer.succeed(Flags, {
		getBoolean: () => Effect.succeed(value),
		getString: () => Effect.die("getString not exercised"),
		getNumber: () => Effect.die("getNumber not exercised"),
		getObject: () => Effect.die("getObject not exercised"),
	} as typeof Flags.Service);

// The publish is fire-and-forget with a `never` error channel — it can never fail the mutation.
const liveStub = Layer.succeed(LivePublisher)(
	livePublisherFor({publish: () => Effect.void, waitUntil: () => {}}),
);

// Named methods are scripted; every OTHER method dies on contact, so a passing test proves the
// resolver reached only the method its path routes to.
const panoProxy = (methods: Partial<typeof Pano.Service>): Layer.Layer<Pano> =>
	Layer.succeed(
		Pano,
		new Proxy(methods, {
			get(target, prop) {
				if (prop in target) return (target as Record<string, unknown>)[prop as string];
				return () => Effect.die(`Pano.${String(prop)} not exercised in post.react`);
			},
		}) as typeof Pano.Service,
	);

const postRowWith = (reactions: ReactionAggregate): PostSummaryRow => ({
	id: "post_1",
	slug: "post-1",
	title: "başlık",
	url: null,
	host: null,
	body: "gövde",
	author: "elif",
	authorId: "u-author",
	score: 3,
	commentCount: 0,
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
	tags: [],
	myVote: null,
	isSaved: null,
	isDraft: null,
	reactions,
});

const react = (
	pano: Layer.Layer<Pano>,
	flags: Layer.Layer<Flags>,
	input: {id: string; emoji: string | null},
	user: typeof CAYLAK | undefined = CAYLAK,
) =>
	resolveWire(mutations["post.react"], {
		input,
		select: ["id", "reactions"],
	}).pipe(
		Effect.provide(Layer.mergeAll(pano, flags, liveStub)),
		// The inert (flag-off) branch re-resolves the post through the real sandbox viewer
		// (#6424), so the moderator axis it probes has to be on the context.
		Effect.provide(
			Layer.mergeAll(
				moderatorAxisLayer({viewerId: user?.id ?? "anon", isModerator: false}),
				// Both stores die on contact: the caylak-visibility flag is off on the only
				// branch that resolves a viewer, so neither may be read.
				inPlaceVisibilityStores({}),
			),
		),
		Effect.provideService(CurrentUser, {user}),
		Effect.provideService(RuntimeContext, runtimeContextStub),
	);

describe("post.react — (1) delegation threads the emoji and echoes the aggregate", () => {
	it.effect("cast: a palette emoji delegates targetKind post and returns the reaction bar", () =>
		Effect.gen(function* () {
			const calls: Array<{postId: string; userId: string; emoji: string | null}> = [];
			const result: ReactToPostResult = {
				post: postRowWith({counts: [{emoji: "👍", count: 1}], myReaction: "👍"}),
				changed: true,
			};
			const post = yield* react(
				panoProxy({
					reactToPost: (i) => {
						calls.push({postId: i.postId, userId: i.userId, emoji: i.emoji});
						return Effect.succeed(result);
					},
				}),
				flagsStub(true),
				{id: "post_1", emoji: "👍"},
			);
			assert.deepStrictEqual(calls, [{postId: "post_1", userId: CAYLAK.id, emoji: "👍"}]);
			assert.deepStrictEqual((post as {reactions?: unknown}).reactions, {
				counts: [{emoji: "👍", count: 1}],
				myReaction: "👍",
			});
		}),
	);

	it.effect("change: a different palette emoji is threaded to the service verbatim", () =>
		Effect.gen(function* () {
			const calls: Array<string | null> = [];
			const post = yield* react(
				panoProxy({
					reactToPost: (i) => {
						calls.push(i.emoji);
						return Effect.succeed({
							post: postRowWith({counts: [{emoji: "🔥", count: 1}], myReaction: "🔥"}),
							changed: true,
						});
					},
				}),
				flagsStub(true),
				{id: "post_1", emoji: "🔥"},
			);
			assert.deepStrictEqual(calls, ["🔥"]);
			assert.deepStrictEqual(
				(post as {reactions?: {myReaction?: string}}).reactions?.myReaction,
				"🔥",
			);
		}),
	);

	it.effect("retract: a null emoji is threaded and the empty aggregate echoes back", () =>
		Effect.gen(function* () {
			const calls: Array<string | null> = [];
			const post = yield* react(
				panoProxy({
					reactToPost: (i) => {
						calls.push(i.emoji);
						return Effect.succeed({post: postRowWith(EMPTY_REACTION_AGGREGATE), changed: true});
					},
				}),
				flagsStub(true),
				{id: "post_1", emoji: null},
			);
			assert.deepStrictEqual(calls, [null]);
			assert.deepStrictEqual((post as {reactions?: unknown}).reactions, EMPTY_REACTION_AGGREGATE);
		}),
	);
});

describe("post.react — (2) a non-palette emoji is rejected at the wire boundary", () => {
	it.effect("an off-palette emoji fails to decode and never reaches the service", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				react(
					panoProxy({
						reactToPost: () => Effect.die("Pano.reactToPost ran on a non-palette emoji"),
					}),
					flagsStub(true),
					{id: "post_1", emoji: "🚀"},
				),
			);
			assert.isTrue(exit._tag === "Failure", "an off-palette emoji fails the decode gate");
			if (exit._tag === "Failure") {
				const error = Cause.findErrorOption(exit.cause);
				assert.isTrue(error._tag === "Some");
				if (error._tag === "Some") {
					assert.strictEqual((error.value as {code?: unknown}).code, "VALIDATION_ERROR");
				}
			}
		}),
	);
});

describe("post.react — (3) flag OFF is inert (dark ship)", () => {
	it.effect("inert: no react lands, the unchanged post is re-resolved and returned", () =>
		Effect.gen(function* () {
			const post = yield* react(
				// `reactToPost` is absent, so it dies on contact: the write must never land while dark.
				panoProxy({
					getPostsByIds: () => Effect.succeed([postRowWith(EMPTY_REACTION_AGGREGATE)]),
				}),
				flagsStub(false),
				{id: "post_1", emoji: "👍"},
			);
			assert.strictEqual((post as {id: string}).id, "post_1");
			assert.deepStrictEqual((post as {reactions?: unknown}).reactions, EMPTY_REACTION_AGGREGATE);
		}),
	);
});

describe("post.react — (4) reactions are ungated (a çaylak reacts, no tier gate)", () => {
	it.effect(
		"a plain newcomer reacts and gets the aggregate back — no VOTE_REQUIRES_YAZAR arm",
		() =>
			Effect.gen(function* () {
				const post = yield* react(
					panoProxy({
						reactToPost: (i) => {
							assert.strictEqual(i.userId, CAYLAK.id);
							return Effect.succeed({
								post: postRowWith({counts: [{emoji: "❤️", count: 1}], myReaction: "❤️"}),
								changed: true,
							});
						},
					}),
					flagsStub(true),
					{id: "post_1", emoji: "❤️"},
				);
				assert.deepStrictEqual(
					(post as {reactions?: {myReaction?: string}}).reactions?.myReaction,
					"❤️",
				);
			}),
	);
});
