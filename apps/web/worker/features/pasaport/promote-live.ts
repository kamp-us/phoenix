/**
 * The ONE post-promote live publish both promotion sites call after a committed çaylak→yazar
 * tier flip, so an open profile reconciles the new `tier` over `/fate/live`. Two triggers
 * flip the same tier — the mod-direct `user.promote` path and the author-vouch tandem — and
 * MUST propagate identically; do not fix one and leave the other stale.
 *
 * The frame carries the re-resolved trusted `User` inline, shaped by the SAME `toUser` the
 * read paths use, so it is byte-identical to a fresh fetch (.patterns/fate-live-views.md).
 *
 * The tier is not all that moves. The same batch sweeps the author's sandbox backlog, and
 * the rows it un-sandboxes are already in subscribers' caches carrying a `sandboxedInPlace`
 * derived at read time. That field cannot ride a payload — see
 * `.patterns/fate-live-consistency.md` — so the swept content is re-announced as an
 * INVALIDATION and each subscriber re-derives it on their own re-read (#6462). Both
 * subscription shapes get one: the connection topics the rows sit in, AND the rows
 * themselves, because a row held by id sits in no connection and the topic invalidations
 * never reach it (ADR 0314).
 *
 * The publish cannot fail the tier flip: `WorkerLivePublisher.update`'s error channel is
 * `never` by contract (.patterns/fate-effect-server.md).
 */

import {Effect} from "effect";
import {WorkerLivePublisher} from "../fate-live/protocol.ts";
import {PanoFeedCache} from "../pano/feed-cache.ts";
import {panoLive} from "../pano/live.ts";
import {sozlukLive} from "../sozluk/live.ts";
import {pasaportLive} from "./live.ts";
import {isEmptySweep, type SandboxSweep} from "./sandbox-sweep.ts";
import {toUser} from "./shapers.ts";
import {getUsersWithModerationByIds} from "./trusted-user.ts";

export {NO_SANDBOX_SWEEP, type SandboxSweep} from "./sandbox-sweep.ts";

const publishSweep = Effect.fn("pasaport.publishSandboxSweep")(function* (sweep: SandboxSweep) {
	if (isEmptySweep(sweep)) return;
	const publisher = yield* WorkerLivePublisher;
	const pano = panoLive(publisher, yield* PanoFeedCache);
	const sozluk = sozlukLive(publisher);

	if (sweep.feed) yield* pano.post.feed.invalidate();
	for (const postId of sweep.commentThreads) {
		yield* pano.comment.thread(postId).invalidate();
	}
	for (const termSlug of sweep.definitionTerms) {
		yield* sozluk.definition.term(termSlug).invalidate();
	}

	for (const id of sweep.postIds) {
		yield* pano.post.invalidate(id);
	}
	for (const id of sweep.commentIds) {
		yield* pano.comment.invalidate(id);
	}
	for (const id of sweep.definitionIds) {
		yield* sozluk.definition.invalidate(id);
	}
});

// A missing row (raced deletion) publishes no `User` frame, but the sweep still fired
// against real content rows, so its invalidations are unconditional.
export const publishPromotion = Effect.fn("pasaport.publishPromotion")(function* (
	userId: string,
	sweep: SandboxSweep,
) {
	const rows = yield* getUsersWithModerationByIds([userId]);
	const row = rows[0];
	if (row) {
		const live = pasaportLive(yield* WorkerLivePublisher);
		yield* live.user.update(userId, {changed: ["tier"], data: toUser(row)});
	}
	yield* publishSweep(sweep);
});
