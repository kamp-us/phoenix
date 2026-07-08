/**
 * Report's live-publish targets — the ONE place that answers "what does a moderator
 * resolve/restore of a reported target publish to?" (#1895, audit #1892).
 *
 * A `report.resolve` (remove) / `report.restore` hides or un-hides a `Post` /
 * `Comment` / `Definition` through the 0096 moderate substrate — the exact three
 * entities that live in the subscribed `posts` / `Post.comments` / `Term.definitions`
 * connections and every other client's normalized cache. The user-initiated deletes
 * publish their invalidation (`pano`/`sozluk` `*.delete` / `*.restore`); the
 * moderator-initiated path went through the parallel `moderateRemove*` service
 * methods and fanned out NOTHING, so a moderator's remove left every other client
 * rendering the removed content live until a manual reload. This binding closes that
 * gap by dispatching report's per-kind publish to the SAME content topics the user
 * paths use — no new report-owned topic (a report is private moderation state with no
 * live view, ADR 0082; `report.listOpen` is a bounded gated read, not a live topic).
 *
 * The typename is sourced off each entity's view (via `panoLive` / `sozlukLive`, which
 * read `PostView.typeName` / `CommentView.typeName` / `DefinitionView.typeName`), never
 * an inline `"Post"` literal (#1127). `deleteEdge` carries no node payload, so the
 * remove fan-out is ungated; the restore re-append is a node broadcast to a viewer-blind
 * public topic (the #1205/#1280 leak surface), so it routes through `decidePublish` on
 * the target's round-tripped sandbox marker — a moderator restore of a sandboxed target
 * is suppressed from the public connection exactly as the user restore paths suppress it.
 *
 * Every bound call forwards to `WorkerLivePublisher`, whose method error channel is
 * `never` — so a failed publish can never fail the moderation action (the fail-safe
 * contract, preserved by construction, same as pano/sozluk).
 */

import {Effect} from "effect";
import type {WorkerLivePublisher} from "../fate-live/protocol.ts";
import {decidePublish} from "../kunye/sandbox.ts";
import type {WorkerPanoFeedCache} from "../pano/feed-cache.ts";
import {panoLive} from "../pano/live.ts";
import type {Comment, Post} from "../pano/views.ts";
import {sozlukLive} from "../sozluk/live.ts";
import type {Definition} from "../sozluk/views.ts";

/**
 * Bind report's moderator-path publish targets to the per-request publisher. Each
 * helper dispatches to the content feature's own live binding by the reported target's
 * kind, so the fan-out lands on the same topic (and same view-sourced typename) the
 * user delete/restore paths publish to. A moderator remove/restore of a `Post`/`Comment`
 * is a feed-visible write, so `feedCache` rides `panoLive` to purge the base feed
 * exactly as the user paths do (ADR 0170 / #2324); sözlük targets never touch the pano
 * feed, so `sozlukLive` takes no purger.
 */
export const reportLive = (live: WorkerLivePublisher, feedCache: WorkerPanoFeedCache) => {
	const pano = panoLive(live, feedCache);
	const sozluk = sozlukLive(live);
	return {
		/**
		 * A moderator removed a reported `Post`: evict the entity from every cache
		 * holding it and drop its edge from the global `posts` feed — the inverse of
		 * `post.delete`'s publish.
		 */
		postRemoved: (postId: string) =>
			Effect.gen(function* () {
				yield* pano.post.delete(postId);
				yield* pano.post.feed.deleteEdge(postId);
			}),
		/**
		 * A moderator restored a `Post`: re-enter the `posts` feed with the full node,
		 * gated on the target's round-tripped sandbox marker (a sandboxed restore stays
		 * out of the public feed), mirroring `post.restore`.
		 */
		postRestored: (post: Post, sandboxedAt: Date | null) =>
			pano.post.feed.appendNode(post.id, {node: post}, decidePublish(sandboxedAt)),
		/**
		 * A moderator removed a reported `Comment`: drop its edge from the parent post's
		 * `Post.comments` thread — the inverse of `comment.delete`'s `deleteEdge`.
		 */
		commentRemoved: (commentId: string, postId: string) =>
			pano.comment.thread(postId).deleteEdge(commentId),
		/**
		 * A moderator restored a `Comment`: re-append it to the parent post's thread,
		 * sandbox-gated, mirroring `comment.restore`.
		 */
		commentRestored: (comment: Comment, postId: string, sandboxedAt: Date | null) =>
			pano.comment
				.thread(postId)
				.appendNode(comment.id, {node: comment}, decidePublish(sandboxedAt)),
		/**
		 * A moderator removed a reported `Definition`: evict the entity and drop its edge
		 * from the term's `Term.definitions` connection — the inverse of `definition.delete`.
		 */
		definitionRemoved: (definitionId: string, termSlug: string) =>
			Effect.gen(function* () {
				yield* sozluk.definition.delete(definitionId);
				yield* sozluk.definition.term(termSlug).deleteEdge(definitionId);
			}),
		/**
		 * A moderator restored a `Definition`: re-enter the term's connection with the
		 * full node, sandbox-gated, mirroring `definition.restore`.
		 */
		definitionRestored: (definition: Definition, termSlug: string, sandboxedAt: Date | null) =>
			sozluk.definition
				.term(termSlug)
				.appendNode(definition.id, {node: definition}, decidePublish(sandboxedAt)),
	};
};
