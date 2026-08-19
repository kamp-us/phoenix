/**
 * `comment.react` wire-boundary coverage (#1864): the mutation driven through
 * `resolveWire` over a stub `Pano` and a `Flags` double, no database. What is proven
 * here is the MUTATION wiring — the write semantics themselves live in
 * `../reaction/Reaction.unit.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Cause, Effect, Exit, Layer} from "effect";
import {UserId} from "../../lib/ids.ts";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {Flags} from "../flagship/Flags.ts";
import {EMPTY_REACTION_AGGREGATE, type ReactionAggregate} from "../reaction/Reaction.ts";
import type {CommentRow} from "./comment-fields.ts";
import type {ReactToCommentInput, ReactToCommentResult} from "./comment-operations.ts";
import {CommentId} from "./ids.ts";
import {mutations} from "./mutations.ts";
import {Pano} from "./Pano.ts";

// A plain member with no tier fields: the ungated proof needs a newcomer.
const CAYLAK = {id: "u-caylak", email: "yeni@example.com", name: "yeni"};

const runtimeContextStub: BaseRuntimeContext = {
	Type: "comment-react-test",
	id: "comment-react-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

// Every typed read dies, so an accidental call is loud.
const flagsStub = (on: boolean): Layer.Layer<Flags> =>
	Layer.succeed(Flags, {
		getBoolean: () => Effect.succeed(on),
		getString: () => Effect.die("getString not exercised"),
		getNumber: () => Effect.die("getNumber not exercised"),
		getObject: () => Effect.die("getObject not exercised"),
	} as typeof Flags.Service);

// Records nothing: the publish is fire-and-forget and can never fail the mutation.
const liveStub = Layer.succeed(LivePublisher)(
	livePublisherFor({publish: () => Effect.void, waitUntil: () => {}}),
);

// Every unscripted method dies on contact, so a pass proves the resolver reached only
// the method its path routes to.
const panoProxy = (methods: Partial<typeof Pano.Service>): Layer.Layer<Pano> =>
	Layer.succeed(
		Pano,
		new Proxy(methods, {
			get(target, prop) {
				if (prop in target) return (target as Record<string, unknown>)[prop as string];
				return () => Effect.die(`Pano.${String(prop)} not exercised in comment.react`);
			},
		}) as typeof Pano.Service,
	);

const commentRowWith = (reactions: ReactionAggregate): CommentRow => ({
	id: "comment_1",
	parentId: null,
	author: "elif",
	authorId: "u-author",
	body: "gövde",
	score: 2,
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
	deletedAt: null,
	myVote: null,
	reactions,
});

const react = (
	pano: Layer.Layer<Pano>,
	on: boolean,
	input: {id: string; emoji: string | null},
	user: typeof CAYLAK | undefined = CAYLAK,
) =>
	resolveWire(mutations["comment.react"], {
		input,
		select: ["id", "reactions"],
	}).pipe(
		Effect.provide(Layer.mergeAll(pano, flagsStub(on), liveStub)),
		Effect.provideService(CurrentUser, {user}),
		Effect.provideService(RuntimeContext, runtimeContextStub),
	);

describe("comment.react — (1) flag ON delegates and echoes the aggregate", () => {
	it.effect("cast: a palette emoji delegates targetKind comment and returns the reaction bar", () =>
		Effect.gen(function* () {
			const calls: ReactToCommentInput[] = [];
			const result: ReactToCommentResult = {
				comment: commentRowWith({counts: [{emoji: "👍", count: 1}], myReaction: "👍"}),
				changed: true,
			};
			const comment = yield* react(
				panoProxy({
					reactToComment: (i) => {
						calls.push(i);
						return Effect.succeed(result);
					},
				}),
				true,
				{id: "comment_1", emoji: "👍"},
			);
			assert.deepStrictEqual(calls, [
				{commentId: CommentId.make("comment_1"), userId: UserId.make(CAYLAK.id), emoji: "👍"},
			]);
			assert.deepStrictEqual((comment as {reactions?: unknown}).reactions, {
				counts: [{emoji: "👍", count: 1}],
				myReaction: "👍",
			});
		}),
	);

	it.effect("change: a different palette emoji is threaded to the service verbatim", () =>
		Effect.gen(function* () {
			const calls: Array<string | null> = [];
			const comment = yield* react(
				panoProxy({
					reactToComment: (i) => {
						calls.push(i.emoji);
						return Effect.succeed({
							comment: commentRowWith({counts: [{emoji: "🔥", count: 1}], myReaction: "🔥"}),
							changed: true,
						});
					},
				}),
				true,
				{id: "comment_1", emoji: "🔥"},
			);
			assert.deepStrictEqual(calls, ["🔥"]);
			assert.deepStrictEqual(
				(comment as {reactions?: {myReaction?: string}}).reactions?.myReaction,
				"🔥",
			);
		}),
	);

	it.effect("retract: a null emoji is threaded and the empty aggregate echoes back", () =>
		Effect.gen(function* () {
			const calls: Array<string | null> = [];
			const comment = yield* react(
				panoProxy({
					reactToComment: (i) => {
						calls.push(i.emoji);
						return Effect.succeed({
							comment: commentRowWith(EMPTY_REACTION_AGGREGATE),
							changed: true,
						});
					},
				}),
				true,
				{id: "comment_1", emoji: null},
			);
			assert.deepStrictEqual(calls, [null]);
			assert.deepStrictEqual(
				(comment as {reactions?: unknown}).reactions,
				EMPTY_REACTION_AGGREGATE,
			);
		}),
	);
});

describe("comment.react — (2) flag OFF is inert (dark ship)", () => {
	it.effect("inert: no react lands, the unchanged comment is re-resolved and returned", () =>
		Effect.gen(function* () {
			const comment = yield* react(
				// reactToComment fail-on-contact: the write must never land when dark.
				panoProxy({
					getCommentsByIds: () => Effect.succeed([commentRowWith(EMPTY_REACTION_AGGREGATE)]),
				}),
				false,
				{id: "comment_1", emoji: "👍"},
			);
			assert.strictEqual((comment as {id: string}).id, "comment_1");
			assert.deepStrictEqual(
				(comment as {reactions?: unknown}).reactions,
				EMPTY_REACTION_AGGREGATE,
			);
		}),
	);
});

describe("comment.react — (3) a non-palette emoji is rejected at the wire boundary", () => {
	it.effect("an off-palette emoji fails to decode and never reaches the service", () =>
		Effect.gen(function* () {
			const exit = yield* react(
				panoProxy({reactToComment: () => Effect.die("reactToComment ran on a non-palette emoji")}),
				true,
				{id: "comment_1", emoji: "🚀"},
			).pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit), "an off-palette emoji fails the decode gate");
			if (Exit.isFailure(exit)) {
				const error = Cause.findErrorOption(exit.cause);
				assert.isTrue(error._tag === "Some");
				if (error._tag === "Some") {
					assert.strictEqual((error.value as {code?: unknown}).code, "VALIDATION_ERROR");
				}
			}
		}),
	);
});

describe("comment.react — (4) reactions are ungated (a çaylak reacts, no tier gate)", () => {
	it.effect("a signed-out reactor gets UNAUTHORIZED — never reaches the service", () =>
		Effect.gen(function* () {
			// Provided explicitly, not through the `react` helper, whose defaulted param
			// would coerce `undefined` back to CAYLAK.
			const exit = yield* resolveWire(mutations["comment.react"], {
				input: {id: "comment_1", emoji: "👍"},
				select: ["id"],
			}).pipe(
				Effect.provide(Layer.mergeAll(panoProxy({}), flagsStub(true), liveStub)),
				Effect.provideService(CurrentUser, {user: undefined}),
				Effect.provideService(RuntimeContext, runtimeContextStub),
				Effect.exit,
			);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) {
				const error = Cause.findErrorOption(exit.cause);
				assert.isTrue(error._tag === "Some");
				if (error._tag === "Some") {
					assert.strictEqual((error.value as {code?: unknown}).code, "UNAUTHORIZED");
				}
			}
		}),
	);

	it.effect("a plain çaylak reacts and gets the aggregate back — no VOTE_REQUIRES_YAZAR arm", () =>
		Effect.gen(function* () {
			const comment = yield* react(
				panoProxy({
					reactToComment: (i) => {
						// No tier gate: a plain user's react reaches the service like any other.
						assert.strictEqual(i.userId, CAYLAK.id);
						return Effect.succeed({
							comment: commentRowWith({counts: [{emoji: "❤️", count: 1}], myReaction: "❤️"}),
							changed: true,
						});
					},
				}),
				true,
				{id: "comment_1", emoji: "❤️"},
			);
			assert.deepStrictEqual(
				(comment as {reactions?: {myReaction?: string}}).reactions?.myReaction,
				"❤️",
			);
		}),
	);
});
