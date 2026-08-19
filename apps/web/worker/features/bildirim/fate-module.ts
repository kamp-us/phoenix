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
	// The resolver owns the keyset order and the recipient scoping.
	"bildirim.list": list(notificationDataView),
	// A synthetic singleton, in the `funnel.summary` shape.
	"bildirim.unreadCount": notificationUnreadDataView,
	// The per-recipient entity the badge and center subscribe to over `/fate/live`.
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
