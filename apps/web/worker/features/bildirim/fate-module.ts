/** bildirim's contribution to the one fate config. See `../fate/module.ts`. */
import {list} from "@nkzw/fate/server";
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {queries} from "./queries.ts";
import {
	notificationChannelSource,
	notificationMarkReceiptSource,
	notificationSource,
	notificationUnreadSource,
} from "./sources.ts";
import {
	notificationChannelDataView,
	notificationDataView,
	notificationUnreadDataView,
} from "./views.ts";

const roots: FateRootsRecord = {
	// The current user's notification center list (#1694) — flag-gated, newest-first;
	// the `bildirim.list` resolver owns the keyset order + recipient scoping.
	"bildirim.list": list(notificationDataView),
	// The topbar badge's unread count — a synthetic singleton, `funnel.summary` shape.
	"bildirim.unreadCount": notificationUnreadDataView,
	// The current user's live notification channel (#1700) — the per-recipient
	// `NotificationChannel` entity the badge + center subscribe to over `/fate/live`.
	"bildirim.channel": notificationChannelDataView,
};

export const fateModule = {
	queries,
	lists,
	mutations,
	sources: [
		notificationSource,
		notificationUnreadSource,
		notificationMarkReceiptSource,
		notificationChannelSource,
	],
	roots,
} satisfies FateModule;
