/**
 * Rite-feedback emitters (#1695/#1696, epic #1666) — the silent rite moments made
 * audible through the spine's {@link Notification} write surface:
 *
 *  - **divan vote** — a divan vote on a çaylak's sandboxed item notifies the
 *    item's author, AGGREGATED per item (`recordAggregate`): repeat votes bump
 *    one unread row's count, never one row per vote (the anti-hype voice). The
 *    aggregate carries no `actor_id` — no per-voter identity drip.
 *  - **kefil** — a recorded vouch notifies the vouched çaylak (one row per
 *    distinct vouch act; an idempotent re-vouch is the caller's `alreadyVouched`
 *    and never reaches here).
 *  - **terfi (promotion)** — the çaylak→yazar tier flip notifies the promoted
 *    member: the single most ceremonial moment in the rite (#1696). Keyed by the
 *    caller on `promoteToYazar`'s `promoted: true`, so a no-op re-promotion
 *    notifies nothing — idempotent by construction. Fired from BOTH promotion
 *    sites (mod-direct and the tandem sweep), the two `promoteToYazar` call sites.
 *
 * Both emitters ride AFTER the committed mutation and can never fail it: the
 * whole effect — flag read included — is swallowed-with-log (`catchCause`, the
 * ADR 0039 fire-and-forget posture; the `persistPanoStats` idiom), which also
 * absorbs the `orDieAccess` DEFECTS a D1 hiccup raises, not just typed errors.
 * Writes are gated on the spine's `phoenix-bildirim` flag (dark by default, one
 * flag for the whole bildirim surface — no per-child flags), and an actor is
 * never notified about their own action ({@link riteRecipient}).
 */
import {Effect} from "effect";
import type {TargetKind} from "../../db/target-kind.ts";
import {bildirimOn} from "./gate.ts";
import type {NotificationKind} from "./kind.ts";
import {bildirimMutedBy} from "./mute-suppression.ts";
import {Notification} from "./Notification.ts";

export const DIVAN_VOTE_KIND: NotificationKind = "divan-vote";
export const KEFIL_KIND: NotificationKind = "kefil";
export const PROMOTION_KIND: NotificationKind = "terfi";

/** Self-suppression, pure: the recipient, or `null` when they ARE the actor. */
export const riteRecipient = (recipientId: string, actorId: string): string | null =>
	recipientId === actorId ? null : recipientId;

const swallow = (label: string) =>
	Effect.catchCause((cause) => Effect.logWarning(`bildirim: ${label} emit swallowed`, cause));

/** Notify a sandboxed item's author of a landed divan vote (aggregated per item). */
export const notifyDivanVote = (input: {
	/** Server-derived item author (`VoteResult.authorId`), never client-supplied. */
	authorId: string;
	actorId: string;
	targetKind: TargetKind;
	targetId: string;
}) =>
	Effect.gen(function* () {
		const recipientId = riteRecipient(input.authorId, input.actorId);
		if (recipientId === null) return;
		if (!(yield* bildirimOn)) return;
		// The aggregate stores `actorId: null`, so the muted check keys on the real
		// interacting divan voter (`actorId`), the identity that survives only here.
		if (yield* bildirimMutedBy(recipientId, input.actorId)) return;
		const bildirim = yield* Notification;
		yield* bildirim.recordAggregate({
			recipientId,
			kind: DIVAN_VOTE_KIND,
			targetKind: input.targetKind,
			targetId: input.targetId,
			actorId: null,
		});
	}).pipe(swallow(DIVAN_VOTE_KIND));

/** Notify the vouched çaylak that a yazar vouched for them. */
export const notifyKefil = (input: {candidateId: string; voucherId: string}) =>
	Effect.gen(function* () {
		const recipientId = riteRecipient(input.candidateId, input.voucherId);
		if (recipientId === null) return;
		if (!(yield* bildirimOn)) return;
		if (yield* bildirimMutedBy(recipientId, input.voucherId)) return;
		const bildirim = yield* Notification;
		yield* bildirim.record({
			recipientId,
			kind: KEFIL_KIND,
			targetKind: "user",
			targetId: recipientId,
			actorId: input.voucherId,
		});
	}).pipe(swallow(KEFIL_KIND));

/**
 * Notify the freshly-promoted member that they crossed çaylak → yazar. No
 * self-suppression question: promotion is a standing the member EARNED, not an
 * act another user did TO them — the recipient IS the subject, `actorId` is null
 * (a ceremonial system event, not a per-actor drip). The target is the member's
 * own account, so the row links to the profile where the new yazar tier shows.
 */
export const notifyPromotion = (input: {userId: string}) =>
	Effect.gen(function* () {
		if (!(yield* bildirimOn)) return;
		const bildirim = yield* Notification;
		yield* bildirim.record({
			recipientId: input.userId,
			kind: PROMOTION_KIND,
			targetKind: "user",
			targetId: input.userId,
			actorId: null,
		});
	}).pipe(swallow(PROMOTION_KIND));
