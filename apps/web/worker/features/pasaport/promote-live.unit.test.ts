/**
 * The çaylak→yazar tier flip must publish a `User` entity update so an open profile
 * view reconciles the new tier over `/fate/live` without a reload — and, for the rows the
 * same batch un-sandboxed, a connection INVALIDATION so each subscriber re-derives its own
 * `sandboxedInPlace` on a fresh read instead of holding the stale `true` an omitted key
 * cannot repair (#6462).
 *
 * The publish is fire-and-forget through `waitUntil`, so `scheduled` collects the
 * detached work and each test drains it before asserting.
 */
import {assert, describe, it} from "@effect/vitest";
import {RelationStore} from "@kampus/authz";
import {LivePublisher} from "@kampus/fate-effect";
import {liveConnectionTopic, liveEntityTopic, liveGlobalConnectionTopic} from "@nkzw/fate/server";
import {Effect, Layer} from "effect";
import * as Schema from "effect/Schema";
import {noopPanoFeedCache} from "../fate/resolve-wire.testing.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import type {PublishMessage} from "../fate-live/protocol.ts";
import {makePasaportStub} from "./Pasaport.testing.ts";
import {publishPromotion} from "./promote-live.ts";
import {NO_SANDBOX_SWEEP, type SandboxSweep} from "./sandbox-sweep.ts";

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

/** Settle the detached `waitUntil` work so the recorder has seen every frame. */
const drain = (scheduled: Array<Promise<unknown>>) =>
	Effect.tryPromise({
		try: () => Promise.allSettled(scheduled),
		catch: (cause) => new DrainRejected({cause}),
	}).pipe(Effect.orDie);

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

/** Two comments on one parent post, so the thread topics dedupe but the row ids do not. */
const sweep: SandboxSweep = {
	feed: true,
	commentThreads: ["p-1", "p-2"],
	definitionTerms: ["effect"],
	postIds: ["p-1", "p-9"],
	commentIds: ["c-1", "c-2"],
	definitionIds: ["d-1"],
};

const recordingLive = () => {
	const recorded: Array<string> = [];
	const frames: Array<{topicKey: string; message: PublishMessage}> = [];
	const scheduled: Array<Promise<unknown>> = [];
	const layer = Layer.succeed(LivePublisher)(
		livePublisherFor({
			publish: (topicKey, message) =>
				Effect.sync(() => {
					recorded.push(topicKey);
					frames.push({topicKey, message});
				}),
			waitUntil: (promise) => {
				scheduled.push(promise);
			},
		}),
	);
	return {layer, recorded, frames, scheduled};
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
			yield* publishPromotion("u-target", NO_SANDBOX_SWEEP);
			yield* drain(scheduled);
			// The topic the global live pin subscribes — see
			// `.patterns/fate-live-consistency.md#global-pin`.
			assert.deepStrictEqual(recorded, [liveEntityTopic("User", "u-target")]);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(pasaportWithUser, relationStoreEmpty, noopPanoFeedCache, layer),
			),
		);
	});

	it.effect("a missing user row (raced deletion) publishes nothing", () => {
		const {layer, recorded, scheduled} = recordingLive();
		return Effect.gen(function* () {
			yield* publishPromotion("u-gone", NO_SANDBOX_SWEEP);
			yield* drain(scheduled);
			assert.deepStrictEqual(recorded, []);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub({getUsersByIds: () => Effect.succeed([])}),
					relationStoreEmpty,
					noopPanoFeedCache,
					layer,
				),
			),
		);
	});

	it.effect("a swept backlog re-announces its content as connection INVALIDATIONS", () => {
		const {layer, frames, scheduled} = recordingLive();
		return Effect.gen(function* () {
			yield* publishPromotion("u-target", sweep);
			yield* drain(scheduled);

			// Every frame the sweep adds is an `invalidate` — a re-read instruction. The
			// marker is derived per reader, so no payload could carry the new value and a
			// stamped one would broadcast the mutator's answer to everyone (#4313).
			const swept = frames.filter(({message}) => message.kind === "connection");
			assert.deepStrictEqual(
				swept.map(({message}) => message.frame),
				[{type: "invalidate"}, {type: "invalidate"}, {type: "invalidate"}, {type: "invalidate"}],
			);
			assert.deepStrictEqual(
				swept.map(({topicKey}) => topicKey),
				[
					liveGlobalConnectionTopic("posts"),
					liveConnectionTopic("Post.comments", {id: "p-1"}),
					liveConnectionTopic("Post.comments", {id: "p-2"}),
					liveConnectionTopic("Term.definitions", {id: "effect"}),
				],
			);
			// The tier frame still rides: the sweep is additive, not a replacement.
			assert.deepStrictEqual(
				frames
					.filter(({message}) => message.kind === "entity" && !("type" in message.frame))
					.map(({topicKey}) => topicKey),
				[liveEntityTopic("User", "u-target")],
			);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(pasaportWithUser, relationStoreEmpty, noopPanoFeedCache, layer),
			),
		);
	});

	it.effect("a swept row is ALSO invalidated by id, for the subscriber holding it alone", () => {
		const {layer, frames, scheduled} = recordingLive();
		return Effect.gen(function* () {
			yield* publishPromotion("u-target", sweep);
			yield* drain(scheduled);

			const byId = frames.filter(
				({message}) => message.kind === "entity" && "type" in message.frame,
			);
			assert.deepStrictEqual(
				byId.map(({topicKey}) => topicKey),
				[
					liveEntityTopic("Post", "p-1"),
					liveEntityTopic("Post", "p-9"),
					liveEntityTopic("Comment", "c-1"),
					liveEntityTopic("Comment", "c-2"),
					liveEntityTopic("Definition", "d-1"),
				],
			);
			// No payload, by ADR 0314's binding constraint: the true new value of a
			// viewer-derived field differs per reader, so the frame says re-read and
			// nothing else. A `data` key here would be the broadcast it exists to avoid.
			assert.deepStrictEqual(
				byId.map(({message}) => message.frame),
				[
					{type: "invalidate", id: "p-1"},
					{type: "invalidate", id: "p-9"},
					{type: "invalidate", id: "c-1"},
					{type: "invalidate", id: "c-2"},
					{type: "invalidate", id: "d-1"},
				],
			);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(pasaportWithUser, relationStoreEmpty, noopPanoFeedCache, layer),
			),
		);
	});

	it.effect("an empty sweep invalidates nothing — no topic, no row", () => {
		const {layer, frames, scheduled} = recordingLive();
		return Effect.gen(function* () {
			yield* publishPromotion("u-target", NO_SANDBOX_SWEEP);
			yield* drain(scheduled);
			assert.deepStrictEqual(
				frames.filter(({message}) => "type" in message.frame),
				[],
			);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(pasaportWithUser, relationStoreEmpty, noopPanoFeedCache, layer),
			),
		);
	});

	it.effect("a DYING publish cannot fail the committed flip (the seam AC)", () => {
		const {layer, scheduled} = dyingLive();
		return Effect.gen(function* () {
			yield* publishPromotion("u-target", NO_SANDBOX_SWEEP);
			yield* drain(scheduled);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(pasaportWithUser, relationStoreEmpty, noopPanoFeedCache, layer),
			),
		);
	});
});
