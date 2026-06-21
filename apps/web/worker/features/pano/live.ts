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
 */

import type {WorkerLivePublisher} from "../fate-live/protocol.ts";
import {LiveTopic} from "../fate-live/protocol.ts";
import {CommentView, PostView} from "./views.ts";

const POST = PostView.typeName;
const COMMENT = CommentView.typeName;

/** A topic publisher narrowed to one entity: `nodeType` is baked in. */
const onTopic = (topic: ReturnType<WorkerLivePublisher["topic"]>, nodeType: string) => ({
	appendNode: (
		id: string | number,
		options?: {node?: unknown; cursor?: string; eventId?: string},
	) => topic.appendNode(nodeType, id, options),
	prependNode: (
		id: string | number,
		options?: {node?: unknown; cursor?: string; eventId?: string},
	) => topic.prependNode(nodeType, id, options),
	deleteEdge: (id: string | number, options?: {eventId?: string}) =>
		topic.deleteEdge(nodeType, id, options),
});

/**
 * Bind pano's publish targets to the per-request publisher. `feed` is the global
 * `posts` connection; `comments(postId)` is the args-scoped `Post.comments`
 * connection keyed by the parent post.
 */
export const panoLive = (live: WorkerLivePublisher) => ({
	post: {
		update: (id: string | number, options?: {changed?: ReadonlyArray<string>; data?: unknown}) =>
			live.update(POST, id, options),
		delete: (id: string | number) => live.delete(POST, id),
		/** The global `posts` feed connection. */
		feed: onTopic(live.topic(LiveTopic.posts), POST),
	},
	comment: {
		update: (id: string | number, options?: {changed?: ReadonlyArray<string>; data?: unknown}) =>
			live.update(COMMENT, id, options),
		/** The args-scoped `Post.comments` connection for one parent post. */
		thread: (postId: string) => onTopic(live.topic(LiveTopic.postComments, {id: postId}), COMMENT),
	},
});
