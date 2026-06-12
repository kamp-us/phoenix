/**
 * fate data views — barrel + cross-feature `Root` composition.
 *
 * Per-feature data views and their derived entity types live in their owning
 * feature (`features/<feature>/views.ts`); this barrel re-exports them so the
 * SPA (and other call sites) keep importing from `worker/features/fate/views`. The
 * client-exposed `Root` and the live-entity type registry compose across all
 * features and stay here — they are intrinsically the cross-feature surface.
 *
 * See `.patterns/fate-data-views.md`.
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
export type {Definition, Term} from "../sozluk/views.ts";
export {definitionDataView, termDataView} from "../sozluk/views.ts";
export type {LandingStats} from "../stats/views.ts";
export {landingStatsDataView} from "../stats/views.ts";

/* -------------------------------------------------------------------------- */
/* Root — client-exposed root queries                                         */
/* -------------------------------------------------------------------------- */

/**
 * Root-level query/list operations the fate Vite plugin turns into typed client
 * roots (read with `useRequest`). A view-based entry is a `query` root; an entry
 * wrapped in `list(...)` is a `list` root. The plugin reads this **value** at
 * build time (`createSchema(views, Root)`) to emit the client roots; at runtime
 * each query root is a `query` operation resolved by its matching
 * `queries.<name>` resolver (so `Root` is not passed to `createFateServer` —
 * see `server.ts` for why `roots` stays empty there).
 *
 * `me` is the "current user" root (fate's documented `viewer` pattern): the
 * `userDataView` declares the shape, and `queries.me` (Auth-gated, reads the
 * canonical Pasaport row) backs it. The byId roots for the other entities are
 * generated from the source registry and don't need a `Root` entry; only
 * custom-resolver roots are declared here.
 *
 * Every screen's roots are declared here: sözlük
 * (`term`/`recentTerms`/`popularTerms`), pano (`post`/`posts`), and pasaport
 * (`profile`/`landingStats`). Each `Root` entry MUST be a `dataView` — the plugin
 * calls `ensureType(view)` on every root — so `landingStats` is backed by a
 * dedicated `landingStatsDataView` entity (a singleton with a constant `id`),
 * not the raw scalar shape. `health` stays off `Root` (no screen reads it).
 *
 * Annotated `Record<string, unknown>` so the export stays nameable: a precise
 * type would surface fate's internal `DataView` symbol (TS2883/TS4023, the same
 * non-portability the `*DataView` annotations dodge). The plugin only inspects
 * this value at runtime (`isDataView` checks), so the loose type is sufficient.
 */
export const Root: Record<string, unknown> = {
	me: userDataView,
	// Sözlük term detail page (`queries.term`); the nested `definitions`
	// connection is carried inline by the resolver (see
	// `.patterns/fate-connections.md`).
	term: termDataView,
	// Sözlük home's two columns. A generated `list` root's NAME must equal the
	// server `lists` resolver name (`recentTerms`/`popularTerms`), so the home
	// reads both in one `useRequest` without aliasing a single `terms` resolver
	// (which the request-key→root-name mapping forbids).
	recentTerms: list(termDataView, {orderBy: [{slug: "asc"}]}),
	popularTerms: list(termDataView, {orderBy: [{slug: "asc"}]}),
	// Pano post detail page (`queries.post`); the nested `comments` connection
	// is carried inline by the resolver.
	post: postDataView,
	// Pano feed (`lists.posts`). Filter args (`sort`/`host`) keep each filtered
	// feed a distinct connection that paginates independently; the feed with no
	// filter args is the registered root list a `post.submit` `insert` reaches
	// (see `.patterns/fate-mutations-client.md`).
	posts: list(postDataView, {orderBy: [{createdAt: "desc"}, {id: "desc"}]}),
	// Public profile page (`queries.profile`); the nested `contributions`
	// discriminant feed is carried inline by the resolver.
	profile: profileDataView,
	// Landing-page stats card (`queries.landingStats`): the single
	// `LandingStats` entity (stamped with a constant `id`) the SPA reads
	// directly.
	landingStats: landingStatsDataView,
};
