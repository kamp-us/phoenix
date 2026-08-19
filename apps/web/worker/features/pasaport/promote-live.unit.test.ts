/**
 * The çaylak→yazar tier flip must publish a `User` entity update so an open profile
 * view reconciles the new tier over `/fate/live` without a reload.
 *
 * The publish is fire-and-forget through `waitUntil`, so `scheduled` collects the
 * detached work and each test drains it before asserting.
 */
import {assert, describe, it} from "@effect/vitest";
import {RelationStore} from "@kampus/authz";
import {LivePublisher} from "@kampus/fate-effect";
import {liveEntityTopic} from "@nkzw/fate/server";
import {Effect, Layer} from "effect";
import * as Schema from "effect/Schema";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {makePasaportStub} from "./Pasaport.testing.ts";
import {publishPromotion} from "./promote-live.ts";

/** A rejection while draining scheduled `waitUntil` work — dies the fiber. */
class DrainRejected extends Schema.TaggedErrorClass<DrainRejected>()("test/DrainRejected", {
	cause: Schema.Unknown,
}) {}

// Nobody moderates: a promoted yazar need not be a moderator, so empty membership is
// the realistic default.
const relationStoreEmpty: Layer.Layer<RelationStore> = Layer.succeed(RelationStore, {
	has: () => Effect.succeed(false),
	hasSubjects: () => Effect.succeed(new Set<string>()),
	subjectsOf: () => Effect.succeed(new Set<string>()),
});

const promotedRecord = {
	id: "u-target",
	email: "u-target@kamp.us",
	name: "Hedef",
	image: null,
	username: "hedef",
	tier: "yazar" as const,
};

const pasaportWithUser = makePasaportStub({
	getUsersByIds: () => Effect.succeed([promotedRecord]),
});

const recordingLive = () => {
	const recorded: Array<string> = [];
	const scheduled: Array<Promise<unknown>> = [];
	const layer = Layer.succeed(LivePublisher)(
		livePublisherFor({
			publish: (topicKey) =>
				Effect.sync(() => {
					recorded.push(topicKey);
				}),
			waitUntil: (promise) => {
				scheduled.push(promise);
			},
		}),
	);
	return {layer, recorded, scheduled};
};

// Delivery DIES — proves the swallow seam keeps `publishPromotion` infallible.
const dyingLive = () => {
	const scheduled: Array<Promise<unknown>> = [];
	const layer = Layer.succeed(LivePublisher)(
		livePublisherFor({
			publish: () => Effect.die(new Error("live delivery blew up")),
			waitUntil: (promise) => {
				scheduled.push(promise);
			},
		}),
	);
	return {layer, scheduled};
};

describe("publishPromotion — the shared post-promote live-publish (#1886)", () => {
	it.effect("publishes a User entity update to the promoted member's topic", () => {
		const {layer, recorded, scheduled} = recordingLive();
		return Effect.gen(function* () {
			yield* publishPromotion("u-target");
			yield* Effect.tryPromise({
				try: () => Promise.allSettled(scheduled),
				catch: (cause) => new DrainRejected({cause}),
			}).pipe(Effect.orDie);
			// The topic the global live pin subscribes — see
			// `.patterns/fate-live-consistency.md#global-pin`.
			assert.deepStrictEqual(recorded, [liveEntityTopic("User", "u-target")]);
		}).pipe(Effect.provide(Layer.mergeAll(pasaportWithUser, relationStoreEmpty, layer)));
	});

	it.effect("a missing user row (raced deletion) publishes nothing", () => {
		const {layer, recorded, scheduled} = recordingLive();
		return Effect.gen(function* () {
			yield* publishPromotion("u-gone");
			yield* Effect.tryPromise({
				try: () => Promise.allSettled(scheduled),
				catch: (cause) => new DrainRejected({cause}),
			}).pipe(Effect.orDie);
			assert.deepStrictEqual(recorded, []);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub({getUsersByIds: () => Effect.succeed([])}),
					relationStoreEmpty,
					layer,
				),
			),
		);
	});

	it.effect("a DYING publish cannot fail the committed flip (the seam AC)", () => {
		const {layer, scheduled} = dyingLive();
		return Effect.gen(function* () {
			yield* publishPromotion("u-target");
			yield* Effect.tryPromise({
				try: () => Promise.allSettled(scheduled),
				catch: (cause) => new DrainRejected({cause}),
			}).pipe(Effect.orDie);
		}).pipe(Effect.provide(Layer.mergeAll(pasaportWithUser, relationStoreEmpty, layer)));
	});
});
