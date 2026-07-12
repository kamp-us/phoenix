/**
 * `comment.react` WIRE-boundary coverage (epic #1840, #1864) — the pano-comment
 * reaction mutation driven through its real external interface (`resolveWire`: the
 * input decode + the `encodeWireError` class→wire-code seam), over a stub `Pano` + a
 * `Flags` double. No database. The direct twin of `definition-reaction-mutation`
 * (#1865) and the comment mirror of `reaction-mutation` (#1863):
 *
 *   - **flag ON delegates.** The resolver hands `{commentId, userId, emoji}` to
 *     `Pano.reactToComment` and echoes the re-resolved comment's `reactions`
 *     aggregate. Cast / change / retract are the three intents threaded (a palette
 *     emoji, a different palette emoji, `null`).
 *   - **flag OFF is inert (dark ship, ADR 0083).** The react never lands
 *     (`reactToComment` fail-on-contact); the resolver re-resolves the unchanged
 *     comment via `getCommentsByIds`, so a merged-but-unflipped feature is invisible.
 *   - **auth-only gate.** A signed-out reactor gets the invisible `UNAUTHORIZED`,
 *     never reaching the service — NO voter-tier gate, so a çaylak reacts like anyone.
 *   - **palette decode.** A non-`REACTION_EMOJI` emoji fails to decode at the wire
 *     boundary (`ReactionEmojiSchema`), so an arbitrary emoji is structurally
 *     unrepresentable and never reaches the service (#1864 AC#1).
 *
 * The react/change/retract write semantics themselves (probe-then-write, cardinality
 * one, NO karma, NO tier gate) are proven over the real service in
 * `../reaction/Reaction.unit.test.ts` (#1861); here we prove the MUTATION wiring.
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

// A plain member — the newcomer/çaylak the ungated proof needs (no tier fields).
const CAYLAK = {id: "u-caylak", email: "yeni@example.com", name: "yeni"};

const runtimeContextStub: BaseRuntimeContext = {
	Type: "comment-react-test",
	id: "comment-react-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

// A `Flags` whose `getBoolean` returns a fixed value — the only method the gate
// calls; every typed read dies so an accidental call is loud.
const flagsStub = (on: boolean): Layer.Layer<Flags> =>
	Layer.succeed(Flags, {
		getBoolean: () => Effect.succeed(on),
		getString: () => Effect.die("getString not exercised"),
		getNumber: () => Effect.die("getNumber not exercised"),
		getObject: () => Effect.die("getObject not exercised"),
	} as typeof Flags.Service);

// A `LivePublisher` that records nothing — the flag-ON path's reaction-count publish
// (#1868) is fire-and-forget with an error channel of `never`, so it can never fail the
// mutation; the stub just satisfies the requirement.
const liveStub = Layer.succeed(LivePublisher)(
	livePublisherFor({publish: () => Effect.void, waitUntil: () => {}}),
);

// A `Pano` whose named methods are scripted; every OTHER method dies on contact, so
// a passing test proves the resolver reached only the method its path routes to.
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

// A `CommentRow` the scripted paths re-resolve — the reaction bar it carries (counts
// + the viewer's own `myReaction`) is what the mutation echoes.
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

// Drive `comment.react` through its real external interface (`resolveWire`), selecting
// the `reactions` aggregate so the echoed field is asserted on the wire shape.
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
			// The current, unreacted aggregate — the react write never happened while dark.
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
			// A genuinely-anonymous request: `{user: undefined}` provided EXPLICITLY (not via
			// the `react` helper, whose defaulted param would coerce `undefined` back to CAYLAK).
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
						// The mutation carries no tier gate: a plain user's react reaches the
						// service exactly like any other — the ungated/social-only model.
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
