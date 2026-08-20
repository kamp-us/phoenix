/** mecmua's contribution to the one fate config. See `../fate/module.ts`. */
import {Fate} from "@kampus/fate-effect";
import {list} from "@nkzw/fate/server";
import {viewOrderBy} from "../../db/ordering.ts";
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {MECMUA_FEED_ORDERING, MECMUA_MINE_ORDERING} from "./ordering.ts";
import {queries} from "./queries.ts";
import {
	MecmuaPostView,
	MecmuaSubscriptionReceiptView,
	mecmuaPostDataView,
	mecmuaSubscriptionReceiptDataView,
} from "./views.ts";

// Both paths return `MecmuaPostView` inline, so the entity needs a source to be
// view-reachable in codegen; a `syntheticSource` (no by-id fetch path) is the minimum.
const mecmuaPostSource = Fate.syntheticSource(MecmuaPostView);
// The subscribe/unsubscribe receipt is delivered inline by its mutation (#2500).
const mecmuaSubscriptionReceiptSource = Fate.syntheticSource(MecmuaSubscriptionReceiptView);

const roots: FateRootsRecord = {
	// The subscribed-author time feed (#2500).
	mecmuaFeed: list(mecmuaPostDataView, {orderBy: viewOrderBy(MECMUA_FEED_ORDERING)}),
	// The author's own posts — drafts + published (#2544), `CurrentUser`-scoped.
	mecmuaMyPosts: list(mecmuaPostDataView, {orderBy: viewOrderBy(MECMUA_MINE_ORDERING)}),
	// Resolved inline by the `mecmuaSubscription` query, keyed on `CurrentUser`.
	mecmuaSubscription: mecmuaSubscriptionReceiptDataView,
};

export const fateModule = {
	queries,
	lists,
	mutations,
	sources: [mecmuaPostSource, mecmuaSubscriptionReceiptSource],
	roots,
} satisfies FateModule;
