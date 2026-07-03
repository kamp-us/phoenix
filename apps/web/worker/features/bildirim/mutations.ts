/**
 * bildirim mutation resolvers (#1694):
 *
 * - `bildirim.markRead` — flip ONE notification read. Recipient scoping lives in
 *   the service predicate (`WHERE id AND recipient_id AND read_at IS NULL`), so a
 *   foreign or unknown id is a `marked: 0` no-op ack — never an existence oracle,
 *   never someone else's row.
 * - `bildirim.markAllRead` — flip every unread notification of the caller.
 *
 * Both are flag-gated ({@link requireBildirimOn}) and `CurrentUser.required`;
 * each ack carries the post-write unread count so the badge settles in the same
 * round-trip. See `.patterns/fate-effect-operations.md`.
 */
import {CurrentUser, Fate, Unauthorized} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {Denied} from "../kunye/errors.ts";
import {requireBildirimOn} from "./gate.ts";
import {Notification} from "./Notification.ts";
import {MARK_ALL_RECEIPT_ID, toMarkReceipt} from "./shapers.ts";
import {NotificationMarkReceiptView} from "./views.ts";

const MarkReadInput = Schema.Struct({
	id: Schema.String,
});

const MarkAllReadInput = Schema.Struct({});

export const mutations = {
	"bildirim.markRead": Fate.mutation(
		{
			input: MarkReadInput,
			type: NotificationMarkReceiptView,
			error: Schema.Union([Unauthorized, Denied]),
		},
		Effect.fn("bildirim.markRead")(function* ({input}) {
			yield* requireBildirimOn;
			const user = yield* CurrentUser.required;
			const bildirim = yield* Notification;
			const {marked} = yield* bildirim.markRead(user.id, input.id);
			const unreadCount = yield* bildirim.unreadCount(user.id);
			return toMarkReceipt(input.id, marked, unreadCount);
		}),
	),

	"bildirim.markAllRead": Fate.mutation(
		{
			input: MarkAllReadInput,
			type: NotificationMarkReceiptView,
			error: Schema.Union([Unauthorized, Denied]),
		},
		Effect.fn("bildirim.markAllRead")(function* () {
			yield* requireBildirimOn;
			const user = yield* CurrentUser.required;
			const bildirim = yield* Notification;
			const {marked} = yield* bildirim.markAllRead(user.id);
			const unreadCount = yield* bildirim.unreadCount(user.id);
			return toMarkReceipt(MARK_ALL_RECEIPT_ID, marked, unreadCount);
		}),
	),
};
