/**
 * Post-promote live-publish coverage (#1886) — the çaylak→yazar tier flip must
 * publish a `User` entity update so an open profile view reconciles the new
 * `tier` over `/fate/live` without a manual reload. This pins the shared
 * `publishPromotion` helper BOTH promotion triggers call, driven through a
 * recording `LivePublisher`:
 *
 *   - the entity topic is the promoted member's `User` topic (`liveEntityTopic`),
 *     so the app-lifetime global live pin's `User` subscription refreshes;
 *   - a no-op flip (already-yazar, `promoted: false`) publishes NOTHING extra
 *     (the caller keys the publish on `promoted`, exactly as `notifyPromotion`);
 *   - a DYING publish CANNOT fail the committed flip (the publisher's error
 *     channel is `never` — the seam swallows and logs, ADR 0039).
 *
 * The publish is fire-and-forget through `waitUntil`; `scheduled` collects the
 * detached work and the test drains it before asserting (the same pattern
 * `sozluk/definition-mutation.unit.test.ts` uses). Ports are scripted stubs — no
 * DB; the real-D1 re-resolution fidelity is the integration tier.
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

// A `RelationStore` where nobody moderates — `moderatorsAmong` (the `isModerator`
// join in `getUsersWithModerationByIds`) reads `hasSubjects`, and a promoted yazar
// need not be a moderator, so an empty membership is the realistic default.
const relationStoreEmpty: Layer.Layer<RelationStore> = Layer.succeed(RelationStore, {
	has: () => Effect.succeed(false),
	hasSubjects: () => Effect.succeed(new Set<string>()),
	subjectsOf: () => Effect.succeed(new Set<string>()),
});

// One `user` record the re-resolve reads back — the promoted member, now `yazar`.
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

// A recording `LivePublisher`: `publish` captures the topic key the resolver's
// `live.update` chose; `waitUntil` collects the fire-and-forget work so the test
// drains it (the publish is detached off the request path).
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

// A `LivePublisher` whose delivery DIES — proves the swallow-with-log seam keeps
// `publishPromotion` infallible (the flip already committed).
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
			// The `User` entity topic keyed on the promoted id — what the global live pin
			// (`.patterns/fate-live-views.md#global-pin`) subscribes, so the profile view
			// reconciles the new tier live.
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
			// The helper itself must succeed even though delivery dies — the failure is
			// caught on the detached promise, never surfacing into this effect.
			yield* publishPromotion("u-target");
			yield* Effect.tryPromise({
				try: () => Promise.allSettled(scheduled),
				catch: (cause) => new DrainRejected({cause}),
			}).pipe(Effect.orDie);
		}).pipe(Effect.provide(Layer.mergeAll(pasaportWithUser, relationStoreEmpty, layer)));
	});
});
