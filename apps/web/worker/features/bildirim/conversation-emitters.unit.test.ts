/**
 * Conversation-moment emitter coverage (#1697, epic #1666) — the decisions that
 * are wrong-or-right with no database (ADR 0082 T1/T2; `.patterns/effect-testing.md`):
 * recipient resolution (post author + parent-comment author), dedupe when they
 * coincide, self-suppression (story 12), the flag containment (dark by default),
 * and the swallow-at-the-seam guarantee — a DYING `Notification` (the `orDieAccess`
 * defect shape) cannot fail the comment mutation. The `Notification` seam is the
 * fail-on-contact stub with only `record` overridden, so touching any other write
 * surface (e.g. the vote path's `recordAggregate`) is a test failure.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import {noRequestFlagOverrides} from "../fate/resolve-wire.testing.ts";
import {Flags} from "../flagship/Flags.ts";
import {notifyCommentReply, REPLY_KIND, replyRecipients} from "./conversation-emitters.ts";
import {makeNotificationStub} from "./Notification.testing.ts";
import type {NotificationRecordInput} from "./Notification.ts";

const runtimeContextStub: BaseRuntimeContext = {
	Type: "conversation-emitters-test",
	id: "conversation-emitters-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

const flagsStub = (on: boolean): Layer.Layer<Flags> =>
	Layer.succeed(
		Flags,
		// biome-ignore lint/plugin: a Flags test double — only getBoolean is exercised here.
		{
			getBoolean: () => Effect.succeed(on),
			getString: () => Effect.die(new Error("unused")),
			getNumber: () => Effect.die(new Error("unused")),
			getObject: () => Effect.die(new Error("unused")),
		} as unknown as typeof Flags.Service,
	);

const requestContext = (on: boolean) =>
	Layer.mergeAll(
		flagsStub(on),
		Layer.succeed(CurrentUser, {user: undefined}),
		Layer.succeed(RuntimeContext, runtimeContextStub),
		noRequestFlagOverrides,
	);

const recordingStub = (calls: NotificationRecordInput[]) =>
	makeNotificationStub({
		record: (input) => {
			calls.push(input);
			return Effect.succeed({id: `n-${calls.length}`});
		},
	});

describe("replyRecipients — recipient resolution, pure", () => {
	it("a top-level comment resolves the post author only", () => {
		assert.deepStrictEqual(
			replyRecipients({postAuthorId: "u-post", parentAuthorId: null, actorId: "u-actor"}),
			["u-post"],
		);
	});

	it("a reply resolves both the post author and the parent-comment author", () => {
		assert.deepStrictEqual(
			replyRecipients({postAuthorId: "u-post", parentAuthorId: "u-parent", actorId: "u-actor"}),
			["u-post", "u-parent"],
		);
	});

	it("dedupes to one when the post author and parent-comment author coincide", () => {
		assert.deepStrictEqual(
			replyRecipients({postAuthorId: "u-same", parentAuthorId: "u-same", actorId: "u-actor"}),
			["u-same"],
		);
	});

	it("self-suppresses: commenting on your own post notifies no one", () => {
		assert.deepStrictEqual(
			replyRecipients({postAuthorId: "u-actor", parentAuthorId: null, actorId: "u-actor"}),
			[],
		);
	});

	it("a self-reply on your own post notifies no one (both authors are the actor)", () => {
		assert.deepStrictEqual(
			replyRecipients({postAuthorId: "u-actor", parentAuthorId: "u-actor", actorId: "u-actor"}),
			[],
		);
	});

	it("a reply to your own comment still notifies the (distinct) post author", () => {
		assert.deepStrictEqual(
			replyRecipients({postAuthorId: "u-post", parentAuthorId: "u-actor", actorId: "u-actor"}),
			["u-post"],
		);
	});
});

describe("notifyCommentReply — the reply emit", () => {
	it.effect("a top-level comment records ONE reply notification for the post author", () =>
		Effect.gen(function* () {
			const calls: NotificationRecordInput[] = [];
			yield* notifyCommentReply({
				commentId: "comm-1",
				postAuthorId: "u-post",
				parentAuthorId: null,
				actorId: "u-actor",
			}).pipe(Effect.provide(Layer.mergeAll(recordingStub(calls), requestContext(true))));
			assert.strictEqual(calls.length, 1);
			assert.deepStrictEqual(calls[0], {
				recipientId: "u-post",
				kind: REPLY_KIND,
				targetKind: "comment",
				targetId: "comm-1",
				actorId: "u-actor",
			});
		}),
	);

	it.effect("a reply records one notification each for the post + parent authors", () =>
		Effect.gen(function* () {
			const calls: NotificationRecordInput[] = [];
			yield* notifyCommentReply({
				commentId: "comm-2",
				postAuthorId: "u-post",
				parentAuthorId: "u-parent",
				actorId: "u-actor",
			}).pipe(Effect.provide(Layer.mergeAll(recordingStub(calls), requestContext(true))));
			assert.strictEqual(calls.length, 2);
			assert.deepStrictEqual(
				calls.map((c) => c.recipientId),
				["u-post", "u-parent"],
			);
		}),
	);

	it.effect("coinciding post + parent authors get exactly one notification", () =>
		Effect.gen(function* () {
			const calls: NotificationRecordInput[] = [];
			yield* notifyCommentReply({
				commentId: "comm-3",
				postAuthorId: "u-same",
				parentAuthorId: "u-same",
				actorId: "u-actor",
			}).pipe(Effect.provide(Layer.mergeAll(recordingStub(calls), requestContext(true))));
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0]?.recipientId, "u-same");
		}),
	);

	it.effect("a self-reply on your own post emits nothing (the stub is never touched)", () =>
		notifyCommentReply({
			commentId: "comm-4",
			postAuthorId: "u-actor",
			parentAuthorId: "u-actor",
			actorId: "u-actor",
		}).pipe(Effect.provide(Layer.mergeAll(makeNotificationStub(), requestContext(true)))),
	);

	it.effect("with the bildirim flag OFF the write never happens (dark by default)", () =>
		notifyCommentReply({
			commentId: "comm-5",
			postAuthorId: "u-post",
			parentAuthorId: "u-parent",
			actorId: "u-actor",
		}).pipe(Effect.provide(Layer.mergeAll(makeNotificationStub(), requestContext(false)))),
	);

	it.effect(
		"a DYING notification write is swallowed — the comment caller still succeeds (the seam AC)",
		() =>
			Effect.gen(function* () {
				// The default stub DIES on contact — the exact defect shape `orDieAccess`
				// raises on a D1 failure. The emitter must swallow it, not surface it.
				const exit = yield* notifyCommentReply({
					commentId: "comm-6",
					postAuthorId: "u-post",
					parentAuthorId: null,
					actorId: "u-actor",
				}).pipe(
					Effect.provide(Layer.mergeAll(makeNotificationStub(), requestContext(true))),
					Effect.exit,
				);
				assert.strictEqual(exit._tag, "Success");
			}),
	);
});
