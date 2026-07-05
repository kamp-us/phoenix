/**
 * Live-content vote emitter (#1698, epic #1666) — the single most common event,
 * silent until now, made audible through the spine's {@link Notification} write
 * surface with the anti-hype aggregated voice:
 *
 *  - **vote** — a landed upvote on a member's live pano post / pano comment /
 *    sözlük definition notifies the item's author, AGGREGATED per item
 *    (`recordAggregate`): repeat votes bump ONE unread row's count ("3 yeni oy"),
 *    never one row per vote and never a per-voter identity drip (`actorId: null`).
 *    After the recipient reads the aggregate, subsequent votes surface as a fresh
 *    unread row (`insertUnlessUnreadStatement` mints one only when no unread row
 *    exists — read history is never rewritten). Self-votes never notify
 *    ({@link voteRecipient}), and a retraction stays silent — the aggregate is
 *    "attention received", not a live score.
 *
 * This is divan's `notifyDivanVote` sibling with the SAME aggregation rule, kept a
 * distinct `vote` kind (not `divan-vote`) because it is the LIVE-content surface:
 * the two carry their own product voice. Divan votes stay out of scope here
 * (covered by the rite-feedback sibling).
 *
 * The emit rides AFTER the committed cast and can never fail it: the whole effect —
 * flag read included — is swallowed-with-log (`catchCause`, the ADR 0039
 * fire-and-forget posture; the rite-emitters idiom), which also absorbs the
 * `orDieAccess` DEFECTS a D1 hiccup raises, not just typed errors. The write is
 * gated on the spine's `phoenix-bildirim` flag (dark by default).
 */
import {Effect} from "effect";
import type {TargetKind} from "../../db/target-kind.ts";
import {bildirimOn} from "./gate.ts";
import type {NotificationKind} from "./kind.ts";
import {Notification} from "./Notification.ts";

export const VOTE_KIND: NotificationKind = "vote";

/** Self-suppression, pure: the recipient, or `null` when they ARE the voter. */
export const voteRecipient = (authorId: string, voterId: string): string | null =>
	authorId === voterId ? null : authorId;

const swallow = (label: string) =>
	Effect.catchCause((cause) => Effect.logWarning(`bildirim: ${label} emit swallowed`, cause));

/**
 * Notify a live item's author of a landed vote, aggregated per item. The caller
 * fires this ONLY on a cast that changed state (`value && result.changed`), so a
 * retraction and an idempotent no-op stay silent.
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
		const bildirim = yield* Notification;
		yield* bildirim.recordAggregate({
			recipientId,
			kind: VOTE_KIND,
			targetKind: input.targetKind,
			targetId: input.targetId,
			actorId: null,
		});
	}).pipe(swallow(VOTE_KIND));
