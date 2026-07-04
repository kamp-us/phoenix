/**
 * Conversation-moment emitters (#1697, epic #1666) — pano's comment activity made
 * audible through the spine's {@link Notification} write surface (stories 4 + 12):
 *
 *  - **reply** — a new comment on a post notifies the post author ("someone replied
 *    to your post"); a threaded reply additionally notifies the parent-comment
 *    author ("someone replied to your comment"). {@link replyRecipients} resolves
 *    the recipient set once — deduped and self-suppressed — so one comment event
 *    yields **at most one** notification per person: when the post author and the
 *    parent-comment author coincide they get one, not two, and the commenter is
 *    never notified about their own comment (story 12).
 *
 * Sözlük is out of scope: definitions under a term are not replies (the brief's
 * "reply to your definition" has no surface today). If sözlük grows a reply
 * primitive, this emitter extends to it then.
 *
 * A reply is a discrete conversation event, so it uses {@link Notification.record}
 * (one row per recipient) — NOT the vote path's aggregate-upsert; "3 yeni oy"
 * aggregation is the anti-hype voice for votes, not for replies.
 *
 * The emit rides AFTER the committed comment mutation and can never fail it: the
 * whole effect — flag read included — is swallowed-with-log (`catchCause`, the
 * ADR 0039 fire-and-forget posture; the rite-emitters idiom), which also absorbs
 * the `orDieAccess` DEFECTS a D1 hiccup raises, not just typed errors. The write
 * is gated on the spine's `phoenix-bildirim` flag (dark by default).
 */
import {Effect} from "effect";
import {bildirimOn} from "./gate.ts";
import type {NotificationKind} from "./kind.ts";
import {Notification} from "./Notification.ts";

export const REPLY_KIND: NotificationKind = "reply";

/**
 * The deduped, self-suppressed recipient set for one comment event (pure).
 *
 * The post author is a candidate for every comment ("reply to your post"); the
 * parent-comment author is added for a threaded reply ("reply to your comment").
 * A `Set` collapses the coincident-author case to one recipient, and the actor is
 * removed last so the commenter is never notified about their own comment — a
 * self-reply on your own post therefore resolves to nobody (story 12).
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
 * Notify the post author (and, for a reply, the parent-comment author) that a new
 * comment landed. The notification target is the new comment for every recipient,
 * so the link lands them on the reply in the thread; the actor is the commenter.
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
			yield* bildirim.record({
				recipientId,
				kind: REPLY_KIND,
				targetKind: "comment",
				targetId: input.commentId,
				actorId: input.actorId,
			});
		}
	}).pipe(swallow(REPLY_KIND));
