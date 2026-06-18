/**
 * fate data views — barrel re-exporting per-feature views, plus the
 * cross-feature client-exposed `Root` composition that lives here because it is
 * intrinsically the cross-feature surface. See `.patterns/fate-data-views.md`.
 */

import {list} from "@nkzw/fate/server";
import {postDataView} from "../pano/views.ts";
import {profileDataView, userDataView} from "../pasaport/views.ts";
import {termDataView} from "../sozluk/views.ts";
import {landingStatsDataView} from "../stats/views.ts";

export type {Comment, Post, Tag} from "../pano/views.ts";
export {commentDataView, postDataView, tagDataView} from "../pano/views.ts";
export type {Contribution, Profile, User} from "../pasaport/views.ts";
export {
	contributionDataView,
	profileDataView,
	userDataView,
} from "../pasaport/views.ts";
export type {ReportReceipt} from "../report/views.ts";
export {reportReceiptDataView} from "../report/views.ts";
export type {Definition, Term} from "../sozluk/views.ts";
export {definitionDataView, termDataView} from "../sozluk/views.ts";
export type {LandingStats} from "../stats/views.ts";
export {landingStatsDataView} from "../stats/views.ts";

/**
 * Root-level query/list operations the fate Vite plugin turns into typed client
 * roots at build time (`createSchema(views, Root)`); a `list(...)`-wrapped entry
 * is a `list` root, a bare view is a `query` root. Only custom-resolver roots are
 * declared here — byId roots are generated from the source registry, and `Root`
 * is not passed to `createFateServer` (`roots` stays empty there).
 *
 * Each entry MUST be a `dataView` — the plugin calls `ensureType(view)` on every
 * root — which is why `landingStats` is backed by a dedicated entity, not the raw
 * scalar shape. The export is annotated `Record<string, unknown>` to stay
 * nameable: a precise type would surface fate's internal `DataView` symbol
 * (TS2883/TS4023); the plugin only inspects this value at runtime.
 */
export const Root: Record<string, unknown> = {
	me: userDataView,
	term: termDataView,
	// A generated `list` root's NAME must equal the server `lists` resolver name,
	// so the home reads both columns in one `useRequest` without aliasing a single
	// `terms` resolver (which the request-key→root-name mapping forbids).
	recentTerms: list(termDataView, {orderBy: [{slug: "asc"}]}),
	popularTerms: list(termDataView, {orderBy: [{slug: "asc"}]}),
	post: postDataView,
	// The feed with no filter args is the registered root list a `post.submit`
	// `insert` reaches (filtered feeds are distinct, independently-paginated
	// connections). See `.patterns/fate-mutations-client.md`.
	posts: list(postDataView, {orderBy: [{createdAt: "desc"}, {id: "desc"}]}),
	// Search roots (ADR 0080) — per-type, reusing the Term/Post views. The orderBy
	// is nominal: the search service ranks by bm25 and owns the keyset, so this
	// declares the root as a `list` but never drives the order (the resolver does).
	searchTerms: list(termDataView, {orderBy: [{slug: "asc"}]}),
	searchPosts: list(postDataView, {orderBy: [{id: "asc"}]}),
	profile: profileDataView,
	landingStats: landingStatsDataView,
};
