/**
 * Pano live-publish targets — the ONE place that answers "what does mutating a
 * Post / Comment publish to?" Each target binds the entity's wire `__typename`
 * (read off the view's `typeName`, never an inline `"Post"`/`"Comment"` literal)
 * to the topic(s) it participates in, so a resolver names the fan-out target
 * instead of restating the magic-string seam (#1127).
 *
 * No behavior change: the bound calls forward verbatim to `WorkerLivePublisher`,
 * so the published frames are byte-identical to the prior inline wiring — the
 * typename is the SAME string (`PostView.typeName === "Post"`), just sourced from
 * the view. The `changed` hint stays a per-resolver argument: it is mutation-
 * specific (which fields a write touched), not a property of the entity, and it
 * does not reach the wire (`live-publisher.ts` builds `{data}` only).
 *
 * `appendNode` / `prependNode` (the create-time node broadcasts, the #1205 leak
 * surface) take a `PublishDecision` and gate through `broadcastIf` — so a resolver
 * cannot broadcast a node to these viewer-blind public topics without discharging the
 * sandbox check (#1280). `deleteEdge` carries no node payload, so it stays ungated.
 *
 * Every one of these publish methods ALSO fires the base-feed edge-cache purge
 * (`feedCache.purge`, ADR 0170 / #2324): a fanned pano write is by construction a
 * feed-visible write (the base feed carries each post's score/reactions/body +
 * `commentCount`), so the SAME seam that publishes the `/fate/live` invalidation
 * purges the cached base feed — one write, two invalidations. The purge is best-effort
 * (`never` channel, `waitUntil`) and gated off the leg-B cache flag inside the purger,
 * so it is a pure no-op until release. The one benign over-fire: the dark-shipped
 * `taslak` path (`post.saveDraft`/`discardDraft`) publishes a private entity update
 * through `post.update`/`post.delete` and thus also purges — harmless (a purge only
 * ever forces a re-fill of an unchanged feed, never serves stale) and unreachable until
 * the draft flag itself is on.
 */

import {Effect} from "effect";
import type {WorkerLivePublisher} from "../fate-live/protocol.ts";
import {LiveTopic} from "../fate-live/protocol.ts";
import {broadcastIf, type PublishDecision} from "../kunye/sandbox.ts";
import type {WorkerPanoFeedCache} from "./feed-cache.ts";
import {CommentView, PostView} from "./views.ts";

const POST = PostView.typeName;
const COMMENT = CommentView.typeName;

/**
 * Run a publish, then fire the base-feed purge alongside it (both `Effect<void>`,
 * `never` channel). `zipRight` sequences the two best-effort invalidations; neither
 * can fail the mutation.
 */
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
});

/**
 * Bind pano's publish targets to the per-request publisher + the base-feed purger.
 * `feed` is the global `posts` connection; `comments(postId)` is the args-scoped
 * `Post.comments` connection keyed by the parent post. Every method fires
 * `feedCache.purge` alongside its live publish (see the module docblock).
 */
export const panoLive = (live: WorkerLivePublisher, feedCache: WorkerPanoFeedCache) => ({
	post: {
		update: (id: string | number, options?: {changed?: ReadonlyArray<string>; data?: unknown}) =>
			withPurge(feedCache, live.update(POST, id, options)),
		delete: (id: string | number) => withPurge(feedCache, live.delete(POST, id)),
		/** The global `posts` feed connection. */
		feed: onTopic(live.topic(LiveTopic.posts), POST, feedCache),
	},
	comment: {
		update: (id: string | number, options?: {changed?: ReadonlyArray<string>; data?: unknown}) =>
			withPurge(feedCache, live.update(COMMENT, id, options)),
		/** The args-scoped `Post.comments` connection for one parent post. */
		thread: (postId: string) =>
			onTopic(live.topic(LiveTopic.postComments, {id: postId}), COMMENT, feedCache),
	},
});
