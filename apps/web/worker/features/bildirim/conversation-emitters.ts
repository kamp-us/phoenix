/**
 * Conversation-moment emitters (#1697, epic #1666): a new comment notifies the post
 * author, and a threaded reply also notifies the parent-comment author — at most one
 * notification per person, never the commenter themselves.
 *
 * Replies use {@link Notification.record} (one row per recipient), NOT the vote path's
 * aggregate-upsert: rollup is the anti-hype voice for votes, not for replies.
 *
 * The emit rides AFTER the committed mutation and can never fail it: the whole effect,
 * flag read included, is swallowed-with-log (ADR 0039), which also absorbs the
 * `orDieAccess` DEFECTS a D1 hiccup raises — not just typed errors.
 */
import {Effect} from "effect";
import {bildirimOn} from "./gate.ts";
import type {NotificationKind} from "./kind.ts";
import {bildirimMutedBy} from "./mute-suppression.ts";
import {Notification} from "./Notification.ts";

export const REPLY_KIND: NotificationKind = "reply";

/**
 * The deduped, self-suppressed recipient set for one comment event (pure). A `Set`
 * collapses the coincident-author case to one recipient, and the actor is removed
 * last, so a self-reply on your own post resolves to nobody (story 12).
 */
export const replyRecipients = (input: {
	postAuthorId: string;
	parentAuthorId: string | null;
	actorId: string;
}): ReadonlyArray<string> => {
	const recipients = new Set<string>([input.postAuthorId]);
	if (input.parentAuthorId !== null) recipients.add(input.parentAuthorId);
	recipients.delete(input.actorId);
	return [...recipients];
};

const swallow = (label: string) =>
	Effect.catchCause((cause) => Effect.logWarning(`bildirim: ${label} emit swallowed`, cause));

/**
 * The notification target is the new comment for every recipient, so the link lands
 * them on the reply in the thread.
 */
export const notifyCommentReply = (input: {
	commentId: string;
	postAuthorId: string;
	parentAuthorId: string | null;
	actorId: string;
}) =>
	Effect.gen(function* () {
		const recipients = replyRecipients(input);
		if (recipients.length === 0) return;
		if (!(yield* bildirimOn)) return;
		const bildirim = yield* Notification;
		for (const recipientId of recipients) {
			// Per-recipient: each recipient is a distinct muter with their own muted set.
			if (yield* bildirimMutedBy(recipientId, input.actorId)) continue;
			yield* bildirim.record({
				recipientId,
				kind: REPLY_KIND,
				targetKind: "comment",
				targetId: input.commentId,
				actorId: input.actorId,
			});
		}
	}).pipe(swallow(REPLY_KIND));
