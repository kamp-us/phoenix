/** divan's contribution to the one fate config. See `../fate/module.ts`. */
import {list} from "@nkzw/fate/server";
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {divanBacklogItemSource, divanCaylakSource, divanVoteReceiptSource} from "./sources.ts";
import {divanBacklogItemDataView, divanCaylakDataView} from "./views.ts";

const roots: FateRootsRecord = {
	// The divan proving-ground reads (#1287, epic #1202) — yazar-OR-mod-gated; the
	// `divan.*` resolvers own the order (roster by pending desc, backlog newest-first).
	"divan.roster": list(divanCaylakDataView),
	"divan.backlog": list(divanBacklogItemDataView),
};

export const fateModule = {
	lists,
	mutations,
	sources: [divanCaylakSource, divanBacklogItemSource, divanVoteReceiptSource],
	roots,
} satisfies FateModule;
