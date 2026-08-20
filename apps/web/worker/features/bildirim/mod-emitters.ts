/**
 * Mod-queue emitters — the moderator team's pager, through the spine's {@link Notification}
 * write surface. `report-filed` pages every moderator on a filed content report, coalesced
 * per reporter per window; `caylak-pending` pages them on a çaylak's FIRST pending item.
 *
 * The recipient set comes from the authority model, never a hardcoded list: {@link
 * allModerators} enumerates every subject holding `(moderates, platform)` — the SAME tuple
 * `Moderate.over(platform)` discharges against (ADR 0107).
 *
 * The emits ride AFTER the committed mutation and can never fail it: the whole effect, flag
 * read and moderator enumeration included, is swallowed-with-log (ADR 0039 fire-and-forget),
 * which also absorbs the `orDieAccess` DEFECTS a D1 hiccup raises, not just typed errors.
 */
import {Duration, Effect} from "effect";
import type {TargetKind} from "../../db/target-kind.ts";
import {Divan} from "../divan/Divan.ts";
import {allModerators} from "../kunye/moderate.ts";
import {bildirimOn} from "./gate.ts";
import type {NotificationKind} from "./kind.ts";
import {Notification} from "./Notification.ts";

export const REPORT_FILED_KIND: NotificationKind = "report-filed";
export const CAYLAK_PENDING_KIND: NotificationKind = "caylak-pending";

// A moderator who triggered the event is never paged about their own action; a `null` actor
// (a system moment) suppresses no one. Sorted for a stable fan-out.
export const modRecipients = (
	moderators: ReadonlySet<string>,
	actorId: string | null,
): ReadonlyArray<string> => [...moderators].filter((id) => id !== actorId).sort();

const swallow = (label: string) =>
	Effect.catchCause((cause) => Effect.logWarning(`bildirim: ${label} emit swallowed`, cause));

/**
 * How long one reporter's mod pages coalesce (#3641, founder ruling on #2562). Bounds the
 * pages a single account can aim at the team by elapsed time, not by how many targets it
 * reports. Wide enough that a report spree is one page, short enough that a genuinely new
 * burst hours later pages again. A release gate on `phoenix-bildirim` — see `gate.ts`.
 */
export const REPORT_PAGE_WINDOW = Duration.minutes(30);

/**
 * Coalesced per reporter per {@link REPORT_PAGE_WINDOW}: the window's first report mints the
 * page and every later report by that reporter bumps its count.
 *
 * Idempotency stays at the call site: `report.submit` emits only on a genuinely `created`
 * report, so a re-report of the same target never reaches here — the window bounds DISTINCT
 * reports, it is not a substitute for that guard.
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
			yield* bildirim.recordDigest(
				{
					recipientId,
					kind: REPORT_FILED_KIND,
					targetKind: input.targetKind,
					targetId: input.targetId,
					actorId: input.reporterId,
				},
				REPORT_PAGE_WINDOW,
			);
		}
	}).pipe(swallow(REPORT_FILED_KIND));

// The target is the çaylak's own account (the roster's unit is the person, not the item).
// A system event with no acting user, so nobody is self-suppressed; the çaylak holds no
// `moderates` tuple, so the moderator set already excludes them.
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
 * Page the moderators only when a çaylak's item lands sandboxed AND it is their FIRST
 * currently-pending item (the 0→1 roster entry). A live item is never a divan entry, so it
 * short-circuits with no read. The whole effect is swallowed, so it cannot fail the create.
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
