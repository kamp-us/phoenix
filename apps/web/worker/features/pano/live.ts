/**
 * Pano live-publish targets — the ONE place that answers "what does mutating a Post /
 * Comment publish to?" Each target binds the entity's wire `__typename` (read off the
 * view's `typeName`, never an inline literal) to the topics it participates in.
 *
 * `appendNode` / `prependNode` take a `PublishDecision` and gate through `broadcastIf`, so
 * a resolver cannot broadcast a node to these viewer-blind public topics without
 * discharging the sandbox check. `deleteEdge` carries no node payload, so it stays ungated.
 * `update` needs neither — it fans an already-public entity — but its payload IS a whole
 * re-resolved node, so it routes through `viewerBlindUpdate` to drop the marker resolved
 * against the mutator's viewer (#6462).
 *
 * Every publish here ALSO purges the base-feed edge cache (ADR 0170): a fanned pano write
 * is by construction a feed-visible write, so one seam fires both invalidations. The purge
 * is best-effort and flag-gated inside the purger, so it is a no-op until release.
 */

import {Effect} from "effect";
import type {WorkerLivePublisher} from "../fate-live/protocol.ts";
import {LiveTopic} from "../fate-live/protocol.ts";
import {broadcastIf, type PublishDecision, viewerBlindUpdate} from "../kunye/sandbox.ts";
import type {WorkerPanoFeedCache} from "./feed-cache.ts";
import {type Comment, CommentView, type Post, PostView} from "./views.ts";

const POST = PostView.typeName;
const COMMENT = CommentView.typeName;

/** Sequences the two best-effort invalidations; neither can fail the mutation. */
const withPurge = (feedCache: WorkerPanoFeedCache, publish: Effect.Effect<void>) =>
	publish.pipe(Effect.flatMap(() => feedCache.purge()));

/** A topic publisher narrowed to one entity: `nodeType` is baked in. */
const onTopic = (
	topic: ReturnType<WorkerLivePublisher["topic"]>,
	nodeType: string,
	feedCache: WorkerPanoFeedCache,
) => ({
	appendNode: (
		id: string | number,
		options: {node?: unknown; cursor?: string; eventId?: string},
		decision: PublishDecision,
	) => withPurge(feedCache, broadcastIf(decision, topic.appendNode(nodeType, id, options))),
	prependNode: (
		id: string | number,
		options: {node?: unknown; cursor?: string; eventId?: string},
		decision: PublishDecision,
	) => withPurge(feedCache, broadcastIf(decision, topic.prependNode(nodeType, id, options))),
	deleteEdge: (id: string | number, options?: {eventId?: string}) =>
		withPurge(feedCache, topic.deleteEdge(nodeType, id, options)),
	/**
	 * Re-read, don't re-state: the subscriber drops the connection and loads it again
	 * through the normal read path, so every viewer-derived field is re-derived against
	 * their OWN viewer. The seam for a change no viewer-blind payload can carry (#6462).
	 */
	invalidate: (options?: {eventId?: string}) => withPurge(feedCache, topic.invalidate(options)),
});

/**
 * `feed` is the global `posts` connection; `comments(postId)` is the args-scoped
 * `Post.comments` connection keyed by the parent post.
 */
export const panoLive = (live: WorkerLivePublisher, feedCache: WorkerPanoFeedCache) => ({
	post: {
		update: (id: string | number, options?: {changed?: ReadonlyArray<string>; data?: Post}) =>
			withPurge(feedCache, live.update(POST, id, viewerBlindUpdate(options))),
		delete: (id: string | number) => withPurge(feedCache, live.delete(POST, id)),
		/** The global `posts` feed connection. */
		feed: onTopic(live.topic(LiveTopic.posts), POST, feedCache),
	},
	comment: {
		update: (id: string | number, options?: {changed?: ReadonlyArray<string>; data?: Comment}) =>
			withPurge(feedCache, live.update(COMMENT, id, viewerBlindUpdate(options))),
		/** The args-scoped `Post.comments` connection for one parent post. */
		thread: (postId: string) =>
			onTopic(live.topic(LiveTopic.postComments, {id: postId}), COMMENT, feedCache),
	},
});
