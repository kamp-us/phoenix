/**
 * Rite-feedback emitters (#1695/#1696) — the silent rite moments made audible
 * through the spine's {@link Notification} write surface.
 *
 * Every emitter rides AFTER the committed mutation and can never fail it: the whole
 * effect, flag read included, is swallowed with a log (ADR 0039's fire-and-forget
 * posture), which absorbs the defects a D1 hiccup raises as well as typed errors.
 * Writes are gated on the one `phoenix-bildirim` flag, and an actor is never notified
 * about their own action.
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
export const BACKLOG_RELEASE_KIND: NotificationKind = "backlog-release";

// Self-suppression: `null` when the recipient IS the actor.
export const riteRecipient = (recipientId: string, actorId: string): string | null =>
	recipientId === actorId ? null : recipientId;

const swallow = (label: string) =>
	Effect.catchCause((cause) => Effect.logWarning(`bildirim: ${label} emit swallowed`, cause));

// Aggregated per item, so repeat votes bump one unread row's count instead of dripping
// one row (and one voter's identity) per vote.
export const notifyDivanVote = (input: {
	// Server-derived, never client-supplied.
	authorId: string;
	actorId: string;
	targetKind: TargetKind;
	targetId: string;
}) =>
	Effect.gen(function* () {
		const recipientId = riteRecipient(input.authorId, input.actorId);
		if (recipientId === null) return;
		if (!(yield* bildirimOn)) return;
		// The aggregate stores `actorId: null`, so the mute check has to key on the real
		// voter here — this is the only place that identity survives.
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

// No self-suppression here: promotion is a standing the member earned, not something
// another user did to them, so the recipient is the subject and `actorId` is null.
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

// The terfi sweep's what-went-public moment (#7061): a system emit like the promotion,
// so no self-suppression and `actorId` null. `count` carries the swept-entry count and 0
// rides too — the client's zero arm (R1.1 on #7049) needs a row to render.
export const notifyBacklogRelease = (input: {userId: string; releasedCount: number}) =>
	Effect.gen(function* () {
		if (!(yield* bildirimOn)) return;
		const bildirim = yield* Notification;
		yield* bildirim.record({
			recipientId: input.userId,
			kind: BACKLOG_RELEASE_KIND,
			targetKind: "user",
			targetId: input.userId,
			actorId: null,
			count: input.releasedCount,
		});
	}).pipe(swallow(BACKLOG_RELEASE_KIND));
