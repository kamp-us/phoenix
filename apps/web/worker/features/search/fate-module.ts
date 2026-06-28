/** search's contribution to the one fate config. See `../fate/module.ts`. */
import {list} from "@nkzw/fate/server";
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {postDataView} from "../pano/views.ts";
import {termDataView} from "../sozluk/views.ts";
import {lists} from "./lists.ts";

// Search roots (ADR 0080) — per-type, reusing the Term/Post views from sözlük/pano
// (search owns no entity of its own). The search service ranks by bm25 and owns the
// keyset (the resolver owns the order).
const roots: FateRootsRecord = {
	searchTerms: list(termDataView),
	searchPosts: list(postDataView),
};

export const fateModule = {lists, roots} satisfies FateModule;
