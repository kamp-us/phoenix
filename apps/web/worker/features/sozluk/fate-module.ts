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
	// The public landing terms (#1424) — live-only recent terms, batched into the
	// landing screen's one `useRequest` beside `landingStats` (ADR 0021). The
	// `landingTerms` resolver owns the recency order + the sandbox mask
	// (`Sozluk.getLandingTerms`, the #1205 definition-arm mask).
	landingTerms: list(termDataView, {orderBy: [{slug: "asc"}]}),
};

export const fateModule = {
	queries,
	lists,
	mutations,
	sources: [definitionSource, termSource],
	roots,
} satisfies FateModule;
