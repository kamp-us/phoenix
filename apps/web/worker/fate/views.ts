/**
 * fate data views — the schema.
 *
 * Data views are the schema (ADR 0018): each `dataView` declares an entity
 * type's fields; the exported `Entity<>` types are the client's types (codegen,
 * no schema artifact). IDs are raw per-type values — no global-ID encoding, no
 * `Node` interface.
 *
 * `Term.definitions` is a `list(definitionDataView, {orderBy})` whose `orderBy`
 * is kept in lockstep with the service's term-page `ORDER BY` (`score desc,
 * createdAt asc, id asc`) so the keyset cursors round-trip (ADR 0019; see
 * `.patterns/fate-connections.md`).
 *
 * See `.patterns/fate-data-views.md`.
 */
import type {SourceDefinition} from "@nkzw/fate/server";
import {dataView, list} from "@nkzw/fate/server";
import type {CommentRow, PostSummaryRow, PostTagRow} from "../features/pano/Pano";
import type {ContributionRow, ProfileRow, UserRow} from "../features/pasaport/Pasaport";
import type {DefinitionRow, TermSummaryRow} from "../features/sozluk/Sozluk";

/**
 * fate's `dataView<Item>` constrains `Item extends Record<string, unknown>`.
 * Service row *interfaces* (like `UserRow`) don't satisfy that — an interface
 * has no implicit string index signature — but a homomorphic mapped type over
 * the same keys does, while preserving each field's type. So fate view rows are
 * declared as `{[K in keyof Row]: Row[K]}` over the service's row type.
 */
type ViewRow<Row> = {[K in keyof Row]: Row[K]};

/**
 * A nameable handle for fate's `DataView` type. `@nkzw/fate/server` re-exports
 * `SourceDefinition` but not the `DataView` it wraps, and `dataView` returns a
 * type carrying an internal symbol key that TypeScript can't name across the
 * module boundary. Annotating the exported view with `SourceDefinition['view']`
 * keeps the export portable.
 */
type DataViewOf<Item extends Record<string, unknown>> = SourceDefinition<Item>["view"];

/**
 * Canonical client-`Entity<>` derivation.
 *
 * fate boxes the two derivation paths against each other: `dataView()`'s
 * inferred return carries an internal `dataViewFieldsKey` symbol that TS can't
 * name across a module boundary (TS2883/TS4023), so an *exported* view must be
 * annotated; but the only portable annotation (`SourceDefinition['view']`)
 * erases the field map, so `Entity<typeof view, …>` then resolves to an empty
 * shape. Neither an annotated nor an un-annotated exported view yields a usable
 * `Entity<>`.
 *
 * The fate Vite plugin doesn't need `Entity<>` — it reads the *runtime* view
 * object (`view.typeName`/`view.fields`) for the schema and manifest, and
 * imports the entity *type names* (`User`, `Term`, …) verbatim from this module
 * as the client's view types. So the canonical derivation lives here: each
 * scalar field set is a standalone `const` (`*Fields`) passed to `dataView`
 * **and** read by `EntityOf<Row, Fields, Name>`, which keeps the row's field
 * types while staying nameable (no symbol). Relation fields (`list(...)`) are
 * declared on the entity type as arrays of the related entity — what the
 * client's `view<T>()` selection masks into `ViewRef`s. The selection const and
 * the `dataView(...)` call share one source of truth, so the client type tracks
 * the view automatically — no hand-restated fields.
 */
type EntityOf<Row, Fields, Name extends string> = {
	[K in keyof Fields as Fields[K] extends true ? K : never]: K extends keyof Row ? Row[K] : never;
} & {__typename: Name};

type UserViewRow = ViewRow<UserRow>;
type DefinitionViewRow = ViewRow<DefinitionRow>;
type TermViewRow = ViewRow<TermSummaryRow>;

const userFields = {
	id: true,
	email: true,
	name: true,
	image: true,
	username: true,
} as const;

export const userDataView: DataViewOf<UserViewRow> = dataView<UserViewRow>("User")(userFields);

/**
 * `Definition` — a single dictionary entry.
 *
 * `author` is the plain author-name string (not a nested `User`), `authorId`
 * gates the edit/delete affordances, and `myVote` is the viewer's `1 | null`
 * upvote flag. The read path batches `myVote` for a whole definition list in one
 * `user_vote` query (`Sozluk.getDefinitionsByIds` / `listDefinitionsKeyset`), so
 * it surfaces here as a plain stamped scalar (no per-row resolver, no N+1).
 */
const definitionFields = {
	id: true,
	body: true,
	score: true,
	author: true,
	authorId: true,
	createdAt: true,
	updatedAt: true,
	myVote: true,
} as const;

export const definitionDataView: DataViewOf<DefinitionViewRow> =
	dataView<DefinitionViewRow>("Definition")(definitionFields);

/**
 * `Term` — a dictionary headword plus its connection of definitions.
 *
 * This view is over `TermSummaryRow` (the list/keyset row). The detail-page
 * `term(slug)` resolver reshapes its `TermPage` into the same row shape (see
 * `queries.ts`).
 *
 * `definitions` is the nested connection. Its `orderBy` MUST equal the service
 * term-page `ORDER BY` — `(score desc, created_at asc, id asc)` — so the
 * keyset cursors the service builds round-trip without skips or dupes
 * (ADR 0019). `id` is the explicit final tiebreaker.
 */
const termFields = {
	id: true,
	slug: true,
	title: true,
	count: true,
	totalScore: true,
	excerpt: true,
	firstAt: true,
	lastEdit: true,
	firstLetter: true,
	definitionCount: true,
	lastActivityAt: true,
} as const;

export const termDataView: DataViewOf<TermViewRow> = dataView<TermViewRow>("Term")({
	...termFields,
	definitions: list(definitionDataView, {
		orderBy: [{score: "desc"}, {createdAt: "asc"}, {id: "asc"}],
	}),
});

/**
 * Client-facing entity types — derived from each view's scalar field selection
 * via `EntityOf` (see the helper's note). The scalar shape comes from the
 * `*Fields` const the `dataView(...)` call shares, so the client type tracks the
 * view without hand-restated fields.
 *
 * Relation fields (`list(...)`) are deliberately **not** on these scalar types:
 * the server attaches each nested connection conditionally (only when selected)
 * as a `ConnectionResult`, and the client masks relations into `ViewRef`s
 * through the view selection rather than reading them off the parent entity.
 */
export type User = EntityOf<UserViewRow, typeof userFields, "User">;
export type Definition = EntityOf<DefinitionViewRow, typeof definitionFields, "Definition">;
/**
 * `Term`'s scalar shape + its `definitions` relation. The relation is declared
 * on the client entity type (not the scalar `*Fields` set) so a client
 * `view<Term>()` can select the nested connection
 * (`{definitions: {items: {node: DefinitionView}}}`) and `useView`/`useListView`
 * type it — the server attaches the `ConnectionResult` conditionally (only when
 * selected) and the client masks it through the view. Optional because the
 * resolver omits it unless `definitions` is in the selection.
 */
export type Term = EntityOf<TermViewRow, typeof termFields, "Term"> & {
	definitions?: Definition[];
};

/* -------------------------------------------------------------------------- */
/* Pano — Post / Comment / Tag                                                 */
/* -------------------------------------------------------------------------- */

type TagViewRow = ViewRow<PostTagRow>;
type CommentViewRow = ViewRow<CommentRow>;
type PostViewRow = ViewRow<PostSummaryRow>;

/**
 * `Tag` — a post's category chip (`kind` + display `label`). Tags are embedded
 * scalars on the post row (parsed from `post_summary.tags` CSV), not a
 * standalone table; the `Post.tags` list carries the pre-built array on the
 * parent row. `kind` is the natural key.
 */
const tagFields = {
	kind: true,
	label: true,
} as const;

export const tagDataView: DataViewOf<TagViewRow> = dataView<TagViewRow>("Tag")(tagFields);

/**
 * `Comment` — a single discussion comment. `author` is the plain author-name
 * string, `authorId` gates edit/delete affordances, `parentId` carries the reply
 * tree, `deletedAt` is the reply-aware soft-delete flag, and `myVote` is the
 * viewer's `1 | null` flag — batched in one `user_vote` read
 * (`Pano.getCommentsByIds` / `listCommentsKeyset`), surfaced here as a stamped
 * scalar (no per-row resolver, no N+1).
 */
const commentFields = {
	id: true,
	parentId: true,
	author: true,
	authorId: true,
	body: true,
	score: true,
	createdAt: true,
	updatedAt: true,
	deletedAt: true,
	myVote: true,
} as const;

export const commentDataView: DataViewOf<CommentViewRow> =
	dataView<CommentViewRow>("Comment")(commentFields);

/**
 * `Post` — a link-aggregator submission plus its connection of comments.
 *
 * Scalar surface: `slug, title, url, host, body, author, authorId, score,
 * commentCount, createdAt, updatedAt, myVote`. `tags` is an embedded scalar
 * array carrying the pre-built `{kind, label}[]` on the row.
 *
 * `comments` is the nested connection. Its `orderBy` MUST equal the service's
 * comment-thread `ORDER BY` — `(created_at asc, id asc)` — so the keyset cursors
 * the service builds round-trip without skips/dupes (ADR 0019). `id` is the
 * explicit final tiebreaker.
 */
const postFields = {
	id: true,
	slug: true,
	title: true,
	url: true,
	host: true,
	body: true,
	author: true,
	authorId: true,
	score: true,
	commentCount: true,
	createdAt: true,
	updatedAt: true,
	myVote: true,
	// `tags` is an **embedded scalar array** (`{kind, label}[]`), NOT a normalized
	// `list(tagDataView)` relation. The tags are parsed from the `post_summary.tags`
	// CSV and ride inline on the post row — there is no standalone tag table. fate's
	// vite codegen builds the client type config from data views only and never
	// carries a source's id field, so it hardcodes the default `getId` (reads `.id`)
	// for every relation entity; `Tag` is keyed by `kind` (no `id`), so a
	// `list(tagDataView)` relation would throw `Missing 'id' on entity record` when
	// the client normalizes the feed/post nodes. Modeling `tags` as a scalar passes
	// the array through verbatim (server → cache) without per-`Tag` normalization.
	// See `.patterns/fate-data-views.md` (embedded-scalar note).
	tags: true,
} as const;

export const postDataView: DataViewOf<PostViewRow> = dataView<PostViewRow>("Post")({
	...postFields,
	comments: list(commentDataView, {orderBy: [{createdAt: "asc"}, {id: "asc"}]}),
});

export type Tag = EntityOf<TagViewRow, typeof tagFields, "Tag">;
export type Comment = EntityOf<CommentViewRow, typeof commentFields, "Comment">;
// `Post.tags` is an embedded scalar array carried on the post row (parsed from
// the `tags` CSV), so it stays on the entity type as the row provides it
// (`PostTagRow[]`); `comments` is a relation, declared on the client entity type
// (not the scalar `*Fields` set) so a client `view<Post>()` can select the nested
// connection (`{comments: {items: {node: CommentView}}}`) and
// `useView`/`useListView` type it. The server attaches the `ConnectionResult`
// conditionally (only when selected) and the client masks it through the view.
// Optional because the `post` resolver omits it unless `comments` is selected.
export type Post = EntityOf<PostViewRow, typeof postFields, "Post"> &
	Pick<PostViewRow, "tags"> & {
		comments?: Comment[];
	};

/* -------------------------------------------------------------------------- */
/* Pasaport — Profile / Contribution                                           */
/* -------------------------------------------------------------------------- */

// The `Profile` view row adds the client normalization key `id` (=== `userId`,
// stamped by the resolver) on top of the service `ProfileRow`.
type ProfileViewRow = ViewRow<ProfileRow> & {id: string};
type ContributionViewRow = ViewRow<ContributionRow>;

/**
 * `Contribution` — the **discriminant** view for the profile contributions feed
 * (ADR 0018: fate has no union type, so a heterogeneous feed is one view with a
 * `kind` discriminant the profile page switches on). `kind` is `"definition" |
 * "post" | "comment"`; the common fields (`id`, `score`, `createdAt`) are always
 * present, and the variant fields are nullable, populated per `kind`:
 *   - definition → `bodyExcerpt`, `termSlug`, `termTitle`
 *   - post       → `title`, `slug`, `bodyExcerpt`
 *   - comment    → `bodyExcerpt`, `postId`, `postTitle`
 *
 * The three variants' fields are flattened onto one row
 * (`Pasaport.toContributionRow`); the profile page reads `kind` and renders the
 * matching row.
 */
const contributionFields = {
	kind: true,
	id: true,
	score: true,
	createdAt: true,
	bodyExcerpt: true,
	termSlug: true,
	termTitle: true,
	title: true,
	slug: true,
	postId: true,
	postTitle: true,
} as const;

export const contributionDataView: DataViewOf<ContributionViewRow> =
	dataView<ContributionViewRow>("Contribution")(contributionFields);

/**
 * `Profile` — a public user profile plus its contributions feed.
 *
 * Carries identity (`username`/`displayName`/`image`) and the live-aggregated
 * counters (`totalKarma`, `definitionCount`, `postCount`, `commentCount`).
 * `userId` is the raw per-type id (no global id — ADR 0018). Identity fields are
 * flat scalars on the profile; the SPA reads them directly off it.
 *
 * `contributions` is the nested connection — a `list(contributionDataView,
 * {orderBy})` whose `orderBy` MUST equal the service's keyset `ORDER BY`
 * (`createdAt desc, id desc`) so the cursors round-trip without skips/dupes
 * (ADR 0019). `id` is the explicit final tiebreaker.
 */
const profileFields = {
	// `id` is the client's normalization key (the codegen hardcodes `getId` to
	// `record.id`). A `Profile` is one-to-one with its user, so `id` === `userId`
	// (stamped by `queries.profile`). `userId` stays for callers that read the
	// raw per-type id directly (the source `byId`
	// is keyed by it). Without an `id` the client throws `Missing 'id' on entity
	// record` when normalizing the profile (same class of constraint as `Tag`
	// — see `.patterns/fate-data-views.md`).
	id: true,
	userId: true,
	username: true,
	displayName: true,
	image: true,
	totalKarma: true,
	definitionCount: true,
	postCount: true,
	commentCount: true,
} as const;

export const profileDataView: DataViewOf<ProfileViewRow> = dataView<ProfileViewRow>("Profile")({
	...profileFields,
	contributions: list(contributionDataView, {
		orderBy: [{createdAt: "desc"}, {id: "desc"}],
	}),
});

export type Contribution = EntityOf<ContributionViewRow, typeof contributionFields, "Contribution">;
/**
 * `Profile`'s scalar shape + its `contributions` relation. The relation is
 * declared on the client entity type (not the scalar `*Fields` set) so a client
 * `view<Profile>()` can select the nested contributions feed
 * (`{contributions: {items: {node: ContributionView}}}`) and
 * `useView`/`useListView` type it — the server attaches the `ConnectionResult`
 * conditionally (only when selected) and the client masks it through the view.
 * `Contribution` is keyed by `id` (a global ULID across the three contribution
 * tables), so the relation is a `list(view)` (it normalizes cleanly — unlike
 * the `Tag` case). Optional because the `profile` resolver omits it unless
 * `contributions` is in the selection.
 */
export type Profile = EntityOf<ProfileViewRow, typeof profileFields, "Profile"> & {
	contributions?: Contribution[];
};

/* -------------------------------------------------------------------------- */
/* Stats — LandingStats                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `LandingStats` — the landing-page counters card. A standalone entity (not a
 * relation) so it can be a `query` client root the SPA reads with `useRequest`.
 *
 * fate's codegen requires every `Root` entry to be a `dataView` with a type
 * name (`createSchema` calls `ensureType(view)` on each root), and the client
 * hardcodes `getId` to `record.id` for normalization — so the entity carries a
 * **stable synthetic `id`** (`"landing"`, stamped by `queries.landingStats`).
 * There's only ever one landing-stats row; the constant id makes it normalize
 * to a single cache record. The four counters + the build `version` are the
 * selectable surface; the SPA reads them directly.
 */
interface LandingStatsViewRow {
	[k: string]: unknown;
	id: string;
	totalDefinitions: number;
	totalPosts: number;
	totalComments: number;
	totalAuthors: number;
	version: string;
}

const landingStatsFields = {
	id: true,
	totalDefinitions: true,
	totalPosts: true,
	totalComments: true,
	totalAuthors: true,
	version: true,
} as const;

export const landingStatsDataView: DataViewOf<LandingStatsViewRow> =
	dataView<LandingStatsViewRow>("LandingStats")(landingStatsFields);

export type LandingStats = EntityOf<LandingStatsViewRow, typeof landingStatsFields, "LandingStats">;

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
	// Sözlük term detail page (`queries.term`). A view-based entry becomes a
	// typed `query` client root; at runtime the native transport dispatches it by
	// the request key (= root name = `term`) to `queries.term`. The `term(slug)`
	// args ride on the `useRequest` item. The nested `definitions` connection is
	// carried inline by the resolver (see `.patterns/fate-connections.md`).
	term: termDataView,
	// Sözlük home's two columns. Each is a `list(...)`-wrapped root → a `list`
	// client root the plugin emits as `FateAPI['lists'][name]`; the generated
	// root NAME must equal the server `lists` resolver name (`recentTerms` /
	// `popularTerms`), so the home reads both in one `useRequest` without aliasing
	// a single `terms` resolver (which the request-key→root-name mapping forbids).
	recentTerms: list(termDataView, {orderBy: [{slug: "asc"}]}),
	popularTerms: list(termDataView, {orderBy: [{slug: "asc"}]}),
	// Pano post detail page (`queries.post`). A view-based entry becomes a typed
	// `query` client root; the native transport dispatches it by the request key
	// (= root name = `post`) to `queries.post`. The `post(idOrSlug)` args ride on
	// the `useRequest` item. The nested `comments` connection is carried inline by
	// the resolver (see `.patterns/fate-connections.md`).
	post: postDataView,
	// Pano feed (`lists.posts`). A `list(...)`-wrapped root → a `list` client root
	// the plugin emits as `FateAPI['lists'][name]`; the generated root NAME must
	// equal the server `lists` resolver name (`posts`). Filter args (`sort`/`host`)
	// keep each filtered feed a distinct connection that paginates independently;
	// the feed with no filter args is the registered root list a `post.submit`
	// `insert` reaches (see `.patterns/fate-mutations-client.md`).
	posts: list(postDataView, {orderBy: [{createdAt: "desc"}, {id: "desc"}]}),
	// Public profile page (`queries.profile`). A view-based entry → a typed
	// `query` client root; the native transport dispatches it by the request key
	// (= root name = `profile`) to `queries.profile`. The `profile(username)` args
	// ride on the `useRequest` item. The nested `contributions` discriminant feed
	// is carried inline by the resolver (see `.patterns/fate-connections.md`).
	profile: profileDataView,
	// Landing-page stats card (`queries.landingStats`). A view-based entry → a
	// typed `query` client root; dispatched by the request key (= `landingStats`)
	// to `queries.landingStats`. Returns the single `LandingStats` entity (stamped
	// with a constant `id`) the SPA reads directly.
	landingStats: landingStatsDataView,
};
