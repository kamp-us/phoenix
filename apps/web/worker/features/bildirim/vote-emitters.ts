/**
 * Live-content vote emitter, with the anti-hype aggregated voice: repeat votes bump ONE
 * unread row's count ("3 yeni oy"), never a row per vote and never a per-voter drip
 * (`actorId: null`). Deliberately a distinct kind from divan's `notifyDivanVote` sibling,
 * because the two carry their own product voice.
 *
 * The emit rides after an already-committed cast, so the whole effect — the flag read
 * included — is swallowed-with-log via `catchCause`, which also absorbs the DEFECTS a D1
 * hiccup raises, not just typed errors.
 */
import {Effect} from "effect";
import type {TargetKind} from "../../db/target-kind.ts";
import {bildirimOn} from "./gate.ts";
import type {NotificationKind} from "./kind.ts";
import {bildirimMutedBy} from "./mute-suppression.ts";
import {Notification} from "./Notification.ts";

export const VOTE_KIND: NotificationKind = "vote";

/** Self-suppression, pure: the recipient, or `null` when they ARE the voter. */
export const voteRecipient = (authorId: string, voterId: string): string | null =>
	authorId === voterId ? null : authorId;

const swallow = (label: string) =>
	Effect.catchCause((cause) => Effect.logWarning(`bildirim: ${label} emit swallowed`, cause));

/**
 * The caller fires this ONLY on a cast that changed state, so a retraction and an
 * idempotent no-op stay silent.
 */
export const notifyContentVote = (input: {
	/** Server-derived item author (`VoteResult.authorId`), never client-supplied. */
	authorId: string;
	voterId: string;
	targetKind: TargetKind;
	targetId: string;
}) =>
	Effect.gen(function* () {
		const recipientId = voteRecipient(input.authorId, input.voterId);
		if (recipientId === null) return;
		if (!(yield* bildirimOn)) return;
		// The aggregate stores `actorId: null`, so the muted-voter check keys on the
		// real interacting member (`voterId`), the identity that survives only here.
		if (yield* bildirimMutedBy(recipientId, input.voterId)) return;
		const bildirim = yield* Notification;
		yield* bildirim.recordAggregate({
			recipientId,
			kind: VOTE_KIND,
			targetKind: input.targetKind,
			targetId: input.targetId,
			actorId: null,
		});
	}).pipe(swallow(VOTE_KIND));
