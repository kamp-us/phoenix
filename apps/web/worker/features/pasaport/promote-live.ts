/**
 * The ONE post-promote live publish both promotion sites call after a committed çaylak→yazar
 * tier flip, so an open profile reconciles the new `tier` over `/fate/live`. Two triggers
 * flip the same tier — the mod-direct `user.promote` path and the author-vouch tandem — and
 * MUST propagate identically; do not fix one and leave the other stale.
 *
 * The frame carries the re-resolved trusted `User` inline, shaped by the SAME `toUser` the
 * read paths use, so it is byte-identical to a fresh fetch (.patterns/fate-live-views.md).
 *
 * The publish cannot fail the tier flip: `WorkerLivePublisher.update`'s error channel is
 * `never` by contract (.patterns/fate-effect-server.md).
 */

import {Effect} from "effect";
import {WorkerLivePublisher} from "../fate-live/protocol.ts";
import {pasaportLive} from "./live.ts";
import {toUser} from "./shapers.ts";
import {getUsersWithModerationByIds} from "./trusted-user.ts";

// A missing row (raced deletion) publishes nothing.
export const publishPromotion = Effect.fn("pasaport.publishPromotion")(function* (userId: string) {
	const rows = yield* getUsersWithModerationByIds([userId]);
	const row = rows[0];
	if (!row) return;
	const live = pasaportLive(yield* WorkerLivePublisher);
	yield* live.user.update(userId, {changed: ["tier"], data: toUser(row)});
});
