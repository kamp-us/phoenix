/** search's contribution to the one fate config. See `../fate/module.ts`. */
import {list} from "@nkzw/fate/server";
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {postDataView} from "../pano/views.ts";
import {termDataView} from "../sozluk/views.ts";
import {lists} from "./lists.ts";

// Search owns no entity of its own, so these roots reuse the sözlük/pano views (ADR
// 0080). The search service ranks by bm25 and owns the keyset.
const roots: FateRootsRecord = {
	searchTerms: list(termDataView),
	searchPosts: list(postDataView),
};

export const fateModule = {lists, roots} satisfies FateModule;
