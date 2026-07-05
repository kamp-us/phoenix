/**
 * Mod-queue emitters (#1699, epic #1666) — the moderator team's pager, through the
 * spine's {@link Notification} write surface (stories 9/10/12):
 *
 *  - **report-filed** — a freshly-filed content report notifies EVERY moderator, so
 *    the two-person team learns of a new item in the queue without polling it. The
 *    target is the reported content, so the row links a moderator straight to it.
 *  - **caylak-pending** — a new çaylak entering the divan review queue notifies every
 *    moderator. Fired by the content-create path only on the çaylak's FIRST currently
 *    pending item (the 0→1 transition — see the divan-side gate), so it is the
 *    "a new çaylak is awaiting review" signal, not one ping per sandboxed item.
 *
 * The recipient set is resolved from the authority model, never a hardcoded list:
 * {@link allModerators} enumerates every subject holding `(moderates, platform)` —
 * the SAME tuple `Moderate.over(platform)` discharges against (ADR 0107). The acting
 * moderator is self-suppressed ({@link modRecipients}): a moderator who files a report
 * is never paged about their own action (story 12). Fan-out is a simple per-recipient
 * loop for the two-person team — no subscription system (the brief).
 *
 * Each moment is discrete, so both use {@link Notification.record} (one row per
 * recipient) — NOT the vote path's aggregate-upsert.
 *
 * The emits ride AFTER the committed report/create mutation and can never fail it: the
 * whole effect — flag read AND the moderator enumeration included — is swallowed-with-log
 * (`catchCause`, the ADR 0039 fire-and-forget posture; the rite-emitters idiom), which
 * also absorbs the `orDieAccess` DEFECTS a D1 hiccup raises, not just typed errors.
 * Writes are gated on the spine's `phoenix-bildirim` flag (dark by default).
 */
import {Effect} from "effect";
import type {TargetKind} from "../../db/target-kind.ts";
import {Divan} from "../divan/Divan.ts";
import {allModerators} from "../kunye/moderate.ts";
import {bildirimOn} from "./gate.ts";
import type {NotificationKind} from "./kind.ts";
import {Notification} from "./Notification.ts";

export const REPORT_FILED_KIND: NotificationKind = "report-filed";
export const CAYLAK_PENDING_KIND: NotificationKind = "caylak-pending";

/**
 * The self-suppressed moderator recipient set for one mod-queue moment (pure): every
 * moderator except the actor. A moderator who triggered the event (e.g. filed the
 * report) is never paged about their own action; a `null` actor (a system moment with
 * no acting user) suppresses no one. Deterministic order for a stable fan-out.
 */
export const modRecipients = (
	moderators: ReadonlySet<string>,
	actorId: string | null,
): ReadonlyArray<string> => [...moderators].filter((id) => id !== actorId).sort();

const swallow = (label: string) =>
	Effect.catchCause((cause) => Effect.logWarning(`bildirim: ${label} emit swallowed`, cause));

/**
 * Notify every moderator that a content report was filed. The target is the reported
 * content (so the row links to it); the actor is the reporter, who is self-suppressed
 * if they are themselves a moderator. `targetKind` is a report {@link TargetKind}
 * (`definition`/`post`/`comment`), a subset of the notification target taxonomy.
 */
export const notifyReportFiled = (input: {
	reporterId: string;
	targetKind: TargetKind;
	targetId: string;
}) =>
	Effect.gen(function* () {
		if (!(yield* bildirimOn)) return;
		const recipients = modRecipients(yield* allModerators(), input.reporterId);
		if (recipients.length === 0) return;
		const bildirim = yield* Notification;
		for (const recipientId of recipients) {
			yield* bildirim.record({
				recipientId,
				kind: REPORT_FILED_KIND,
				targetKind: input.targetKind,
				targetId: input.targetId,
				actorId: input.reporterId,
			});
		}
	}).pipe(swallow(REPORT_FILED_KIND));

/**
 * Notify every moderator that a new çaylak entered the divan review queue. The target
 * is the çaylak's own account (the roster's unit is the person, not the item); the
 * moment is a system event with no acting user, so `actorId` is null and no moderator
 * is self-suppressed. The çaylak itself is never a recipient (they hold no `moderates`
 * tuple), so the moderator set already excludes them.
 */
export const notifyCaylakPending = (input: {caylakId: string}) =>
	Effect.gen(function* () {
		if (!(yield* bildirimOn)) return;
		const recipients = modRecipients(yield* allModerators(), null);
		if (recipients.length === 0) return;
		const bildirim = yield* Notification;
		for (const recipientId of recipients) {
			yield* bildirim.record({
				recipientId,
				kind: CAYLAK_PENDING_KIND,
				targetKind: "user",
				targetId: input.caylakId,
				actorId: null,
			});
		}
	}).pipe(swallow(CAYLAK_PENDING_KIND));

/**
 * The content-create wiring for {@link notifyCaylakPending}: page the moderators only
 * when a çaylak's item lands sandboxed AND it is their FIRST currently-pending item —
 * the 0→1 roster entry (`Divan.pendingCountOf === 1` right after the item committed).
 * A live item (`sandboxedAt === null` — flag-off or a yazar) is never a divan entry, so
 * it short-circuits with no read; a çaylak's second+ item leaves the count > 1 and
 * pages nobody. The whole effect (the count read included) is swallowed by
 * {@link notifyCaylakPending}, so it can never fail the committed create.
 */
export const notifyCaylakEntersDivan = (input: {authorId: string; sandboxedAt: Date | null}) =>
	Effect.gen(function* () {
		if (input.sandboxedAt === null) return;
		if (!(yield* bildirimOn)) return;
		const divan = yield* Divan;
		const pending = yield* divan.pendingCountOf(input.authorId);
		if (pending !== 1) return;
		yield* notifyCaylakPending({caylakId: input.authorId});
	}).pipe(swallow(CAYLAK_PENDING_KIND));
