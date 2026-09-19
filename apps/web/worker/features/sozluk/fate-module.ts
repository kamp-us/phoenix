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
	// The general term list, and the only one that takes a `letter`: the letter index reads it
	// with `sort: "alphabetical"` (#9267). Declared here so the client can reach it at all — a
	// resolver with no root of its own types as `never` at `useRequest`.
	terms: list(termDataView, {orderBy: [{slug: "asc"}]}),
	recentTerms: list(termDataView, {orderBy: [{slug: "asc"}]}),
	popularTerms: list(termDataView, {orderBy: [{slug: "asc"}]}),
	// The `landingTerms` resolver owns the recency order + the sandbox mask; the
	// `orderBy` here is only the root's declared shape.
	landingTerms: list(termDataView, {orderBy: [{slug: "asc"}]}),
};

export const fateModule = {
	queries,
	lists,
	mutations,
	sources: [definitionSource, termSource],
	roots,
} satisfies FateModule;
