/** divan's contribution to the one fate config. See `../fate/module.ts`. */
import type {FateModule} from "../fate/module.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {divanBacklogItemSource, divanCaylakSource, divanVoteReceiptSource} from "./sources.ts";

export const fateModule = {
	lists,
	mutations,
	sources: [divanCaylakSource, divanBacklogItemSource, divanVoteReceiptSource],
} satisfies FateModule;
