/** divan's contribution to the one fate config. See `../fate/module.ts`. */
import {list} from "@nkzw/fate/server";
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {queries} from "./queries.ts";
import {
	divanBacklogItemSource,
	divanCaylakSource,
	divanPendingSource,
	divanVoteReceiptSource,
} from "./sources.ts";
import {divanBacklogItemDataView, divanCaylakDataView, divanPendingDataView} from "./views.ts";

const roots: FateRootsRecord = {
	// The `divan.*` resolvers own the order: roster by pending desc, backlog newest-first.
	"divan.roster": list(divanCaylakDataView),
	"divan.backlog": list(divanBacklogItemDataView),
	// A synthetic singleton, in the `bildirim.unreadCount` shape (#6760).
	"divan.pendingCount": divanPendingDataView,
};

export const fateModule = {
	lists,
	mutations,
	queries,
	sources: [divanCaylakSource, divanBacklogItemSource, divanVoteReceiptSource, divanPendingSource],
	roots,
} satisfies FateModule;
