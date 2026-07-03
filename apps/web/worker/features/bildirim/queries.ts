/**
 * `bildirim.unreadCount` — the topbar badge's read: the current user's unread
 * count as the `NotificationUnread` synthetic singleton (`id: "unread"`, the
 * `funnel.summary` idiom — the wire type is the NAME string, so the entity stays
 * off the source-completeness fetch path). Flag-gated; signed-out reads a
 * well-formed 0, never an error — the badge simply doesn't render.
 */
import {CurrentUser, Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {Denied} from "../kunye/errors.ts";
import {requireBildirimOn} from "./gate.ts";
import {Notification} from "./Notification.ts";
import {toNotificationUnread} from "./shapers.ts";

export const queries = {
	"bildirim.unreadCount": Fate.query(
		{type: "NotificationUnread", error: Schema.Union([Denied])},
		Effect.fn("bildirim.unreadCount")(function* () {
			yield* requireBildirimOn;
			const {user} = yield* CurrentUser;
			if (!user?.id) return toNotificationUnread(0);
			const bildirim = yield* Notification;
			return toNotificationUnread(yield* bildirim.unreadCount(user.id));
		}),
	),
};
