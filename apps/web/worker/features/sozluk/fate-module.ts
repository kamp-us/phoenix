/** sözlük's contribution to the one fate config. See `../fate/module.ts`. */
import {list} from "@nkzw/fate/server";
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {queries} from "./queries.ts";
import {definitionSource, termSource} from "./sources.ts";
import {termDataView} from "./views.ts";

const roots: FateRootsRecord = {
	term: termDataView,
	// A generated `list` root's NAME must equal the server `lists` resolver name,
	// so the home reads both columns in one `useRequest` without aliasing a single
	// `terms` resolver (which the request-key→root-name mapping forbids).
	recentTerms: list(termDataView, {orderBy: [{slug: "asc"}]}),
	popularTerms: list(termDataView, {orderBy: [{slug: "asc"}]}),
};

export const fateModule = {
	queries,
	lists,
	mutations,
	sources: [definitionSource, termSource],
	roots,
} satisfies FateModule;
