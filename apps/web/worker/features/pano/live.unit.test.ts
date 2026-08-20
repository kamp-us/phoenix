/**
 * `panoLive` — the pano publish seam. Pins that every fanned publish method fires the
 * base-feed edge-cache purge ALONGSIDE its `/fate/live` publish, so one write drives both
 * invalidations (ADR 0155 / ADR 0170).
 */
import {assert, it} from "@effect/vitest";
import {Effect} from "effect";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import type {PublishMessage} from "../fate-live/protocol.ts";
import {alwaysLive} from "../kunye/sandbox.ts";
import type {WorkerPanoFeedCache} from "./feed-cache.ts";
import {panoLive} from "./live.ts";
import {toComment, toPost} from "./shapers.ts";

function recordingPublisher() {
	return livePublisherFor({publish: () => Effect.void, waitUntil: () => {}});
}

function countingFeedCache() {
	let purges = 0;
	const feedCache: WorkerPanoFeedCache = {
		purge: () =>
			Effect.sync(() => {
				purges += 1;
			}),
	};
	return {feedCache, get: () => purges};
}

it.effect("post.submit's feed prepend fires the base-feed purge alongside the publish", () =>
	Effect.gen(function* () {
		const live = recordingPublisher();
		const {feedCache, get} = countingFeedCache();
		const pano = panoLive(live, feedCache);

		yield* pano.post.feed.prependNode("p1", {node: {id: "p1"}}, alwaysLive);

		assert.strictEqual(get(), 1);
	}),
);

it.effect("post field update (vote/react/edit) fires the purge", () =>
	Effect.gen(function* () {
		const live = recordingPublisher();
		const {feedCache, get} = countingFeedCache();
		const pano = panoLive(live, feedCache);

		yield* pano.post.update("p1", {changed: ["score"]});
		yield* pano.post.delete("p2");

		assert.strictEqual(get(), 2);
	}),
);

it.effect("comment mutations fire the purge (base feed carries commentCount)", () =>
	Effect.gen(function* () {
		const live = recordingPublisher();
		const {feedCache, get} = countingFeedCache();
		const pano = panoLive(live, feedCache);

		yield* pano.comment.update("c1", {changed: ["score"]});
		yield* pano.comment.thread("p1").appendNode("c1", {node: {id: "c1"}}, alwaysLive);
		yield* pano.comment.thread("p1").deleteEdge("c1");

		assert.strictEqual(get(), 3);
	}),
);

// #6462: an entity `update` fans a whole re-resolved node onto a viewer-blind topic, and
// fate merges that node key-by-key over every subscriber's cache. `sandboxedInPlace` is
// resolved against the MUTATOR's viewer, so it must not ride along — its absence is what
// leaves each subscriber's own read-derived value standing.
function capturingPublisher() {
	const messages: Array<PublishMessage> = [];
	const live = livePublisherFor({
		publish: (_topicKey, message) => {
			messages.push(message);
			return Effect.void;
		},
		waitUntil: () => {},
	});
	return {live, messages};
}

const publishedData = (messages: ReadonlyArray<PublishMessage>): Record<string, unknown> => {
	const [message] = messages;
	if (message === undefined || message.kind !== "entity" || !("data" in message.frame)) {
		throw new Error("expected exactly one entity frame carrying a data payload");
	}
	return message.frame.data as Record<string, unknown>;
};

const markedPost = toPost({
	id: "p1",
	slug: "bir-baslik",
	title: "bir başlık",
	url: null,
	host: null,
	body: "gövde",
	author: "bir çaylak",
	authorId: "u-caylak",
	score: 3,
	commentCount: 0,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	sandboxedInPlace: true,
	tags: [],
});

const markedComment = toComment({
	id: "c1",
	parentId: null,
	author: "bir çaylak",
	authorId: "u-caylak",
	body: "bir yorum",
	score: 1,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	sandboxedInPlace: true,
});

it.effect("a post update publishes no sandboxedInPlace key, so no subscriber's marker moves", () =>
	Effect.gen(function* () {
		const {live, messages} = capturingPublisher();
		const {feedCache} = countingFeedCache();

		yield* panoLive(live, feedCache).post.update("p1", {changed: ["score"], data: markedPost});

		const data = publishedData(messages);
		assert.isFalse("sandboxedInPlace" in data);
		// The rest of the node still rides — this drops one key, it does not gut the frame.
		assert.strictEqual(data.score, 3);
	}),
);

it.effect("a comment update publishes no sandboxedInPlace key", () =>
	Effect.gen(function* () {
		const {live, messages} = capturingPublisher();
		const {feedCache} = countingFeedCache();

		yield* panoLive(live, feedCache).comment.update("c1", {
			changed: ["body"],
			data: markedComment,
		});

		assert.isFalse("sandboxedInPlace" in publishedData(messages));
	}),
);

it.effect("a data-less update still publishes its frame", () =>
	Effect.gen(function* () {
		const {live, messages} = capturingPublisher();
		const {feedCache} = countingFeedCache();

		yield* panoLive(live, feedCache).post.update("p1", {changed: ["score"]});

		assert.strictEqual(messages.length, 1);
	}),
);
