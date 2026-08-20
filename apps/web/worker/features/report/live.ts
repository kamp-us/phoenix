/**
 * What a moderator resolve/restore publishes to (#1895). It deliberately owns NO topic of
 * its own — a report is private moderation state with no live view (ADR 0082) — and
 * instead dispatches to the SAME content topics the user delete/restore paths use.
 *
 * `deleteEdge` carries no node payload, so the remove fan-out is ungated. The restore
 * re-append broadcasts a node to a viewer-blind public topic (the #1205/#1280 leak
 * surface), so it must route through `decidePublish` on the target's sandbox marker.
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
 * `feedCache` rides `panoLive` because a moderator remove/restore of a `Post`/`Comment` is
 * a feed-visible write and must purge the base feed (ADR 0170). Sözlük targets never touch
 * the pano feed, so `sozlukLive` takes no purger.
 */
export const reportLive = (live: WorkerLivePublisher, feedCache: WorkerPanoFeedCache) => {
	const pano = panoLive(live, feedCache);
	const sozluk = sozlukLive(live);
	return {
		postRemoved: (postId: string) =>
			Effect.gen(function* () {
				yield* pano.post.delete(postId);
				yield* pano.post.feed.deleteEdge(postId);
			}),
		postRestored: (post: Post, sandboxedAt: Date | null) =>
			pano.post.feed.appendNode(post.id, {node: post}, decidePublish(sandboxedAt)),
		commentRemoved: (commentId: string, postId: string) =>
			pano.comment.thread(postId).deleteEdge(commentId),
		commentRestored: (comment: Comment, postId: string, sandboxedAt: Date | null) =>
			pano.comment
				.thread(postId)
				.appendNode(comment.id, {node: comment}, decidePublish(sandboxedAt)),
		definitionRemoved: (definitionId: string, termSlug: string) =>
			Effect.gen(function* () {
				yield* sozluk.definition.delete(definitionId);
				yield* sozluk.definition.term(termSlug).deleteEdge(definitionId);
			}),
		definitionRestored: (definition: Definition, termSlug: string, sandboxedAt: Date | null) =>
			sozluk.definition
				.term(termSlug)
				.appendNode(definition.id, {node: definition}, decidePublish(sandboxedAt)),
	};
};
