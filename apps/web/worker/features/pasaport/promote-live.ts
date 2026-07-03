/**
 * The shared post-promote live-publish (#1886) — the ONE helper both promotion
 * sites call after a committed çaylak→yazar tier flip so an open profile/`User`
 * view reconciles the new `tier` over `/fate/live` without a manual reload.
 *
 * Two triggers flip the same tier through `Pasaport.promoteToYazar` and MUST
 * propagate live identically (do not fix one and leave the other stale):
 *   - the mod-direct `user.promote` path (`mutations.ts` `promoteGated`), and
 *   - the order-independent author-vouch tandem (`tandem.ts` `resolveTandem`),
 *     itself fired from both `user.vouch` and the divan karma vote (#1289).
 *
 * Factoring the publish here (rather than duplicating it at each call site) is
 * the #1886 acceptance's "factor a shared helper so both paths publish".
 *
 * The published frame carries the freshly re-resolved trusted `User` entity
 * inline: `getUsersWithModerationByIds` re-reads the row (the same trusted read
 * the by-id `userSource` uses, with the flipped `tier` + `isModerator` joined),
 * then `toUser` stamps the `__typename`-carrying wire shape — the SAME shaper the
 * read paths use, so the live frame is byte-identical to a fresh fetch and each
 * subscribed client masks it to its own selection with no re-resolution (the
 * inline-data contract, `.patterns/fate-live-views.md`). `changed: ["tier"]`
 * names the field the flip touched.
 *
 * The publish CANNOT fail the tier flip: `WorkerLivePublisher.update`'s error
 * channel is `never` by contract (`.patterns/fate-effect-server.md`), so this
 * helper's whole effect is infallible — a live-seam hiccup never rolls back a
 * committed promotion. Callers key it on `promoted` (a no-op already-yazar flip
 * publishes nothing).
 */

import {Effect} from "effect";
import {WorkerLivePublisher} from "../fate-live/protocol.ts";
import {pasaportLive} from "./live.ts";
import {toUser} from "./shapers.ts";
import {getUsersWithModerationByIds} from "./trusted-user.ts";

/**
 * Publish the promoted member's `User` tier update. Re-resolves the trusted
 * `User` row for `userId`, shapes it through `toUser`, and fires
 * `live.update("User", userId, {changed: ["tier"], data})`. A missing row (raced
 * deletion) publishes nothing — `getUsersWithModerationByIds` returns no row, so
 * there is no entity to send.
 */
export const publishPromotion = Effect.fn("pasaport.publishPromotion")(function* (userId: string) {
	const rows = yield* getUsersWithModerationByIds([userId]);
	const row = rows[0];
	if (!row) return;
	const live = pasaportLive(yield* WorkerLivePublisher);
	yield* live.user.update(userId, {changed: ["tier"], data: toUser(row)});
});
