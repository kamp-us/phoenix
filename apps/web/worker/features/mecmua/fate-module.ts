/** mecmua's contribution to the one fate config. See `../fate/module.ts`. */
import {Fate} from "@kampus/fate-effect";
import {list} from "@nkzw/fate/server";
import {viewOrderBy} from "../../db/ordering.ts";
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {MECMUA_FEED_ORDERING} from "./ordering.ts";
import {MecmuaPostView, MecmuaSubscriptionReceiptView, mecmuaPostDataView} from "./views.ts";

// The write path + feed both return `MecmuaPostView` inline, so the entity needs a
// source to be view-reachable in codegen. A `syntheticSource` (no by-id fetch path) is
// the minimal footprint — the mutation/feed resolver delivers the rows in its response.
const mecmuaPostSource = Fate.syntheticSource(MecmuaPostView);
// The subscribe/unsubscribe receipt is delivered inline by its mutation (#2500).
const mecmuaSubscriptionReceiptSource = Fate.syntheticSource(MecmuaSubscriptionReceiptView);

const roots: FateRootsRecord = {
	// The subscribed-author time feed (#2500). The `mecmuaFeed` resolver owns the order
	// (`publishedAt desc, id desc`, single-sourced from `MECMUA_FEED_ORDERING`) + the
	// published mask + the subscribed-author selection.
	mecmuaFeed: list(mecmuaPostDataView, {orderBy: viewOrderBy(MECMUA_FEED_ORDERING)}),
};

export const fateModule = {
	lists,
	mutations,
	sources: [mecmuaPostSource, mecmuaSubscriptionReceiptSource],
	roots,
} satisfies FateModule;
