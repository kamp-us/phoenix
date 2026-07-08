/**
 * `panoLive` — the pano publish seam (ADR 0155). AC#2 of #2324 (ADR 0170): every
 * fanned pano publish method fires the base-feed edge-cache purge ALONGSIDE its
 * `/fate/live` publish, the cache-side twin of the live fan-out. This pins that
 * one write drives BOTH invalidations at the seam, mirroring the live-publisher tests.
 *
 * Unit tier (ADR 0082): stubs at the publisher + purger seam, zero storage.
 */
import {assert, it} from "@effect/vitest";
import {Effect} from "effect";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {alwaysLive} from "../kunye/sandbox.ts";
import type {WorkerPanoFeedCache} from "./feed-cache.ts";
import {panoLive} from "./live.ts";

/** A real (typed) publisher whose delivery is a no-op — only the purge count matters here. */
function recordingPublisher() {
	return livePublisherFor({publish: () => Effect.void, waitUntil: () => {}});
}

/** A purger that counts `purge()` invocations. */
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
