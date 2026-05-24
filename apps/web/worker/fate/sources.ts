/**
 * Hand-built `SourceResolver` — Effect-backed reads.
 *
 * fate is pure transport (ADR 0016): it never queries D1. Every source
 * executor delegates to an Effect service method through {@link fateSource},
 * so all read logic stays in the domain layer. `createDrizzleSourceAdapter` is
 * banned.
 *
 * fate 1.0.3 does **not** export `createSourceDefinition` /
 * `getDataViewSourceConfig` / `createSourceRegistry` / `getBaseDataView` (only
 * the public `createDrizzleSourceAdapter`, which phoenix bans), so the three
 * pieces are built directly:
 *
 *   - each `SourceDefinition` is a plain object literal `{id, view, orderBy?}`,
 *   - the `registry` is a `new Map` keyed by the `SourceDefinition` *object*
 *     (fate looks executors up by object identity),
 *   - `getSource` resolves a view to its definition by `view.typeName`,
 *     returning the *same* object used as the registry key.
 *
 * Task 2 scope: the sozluk sources — `Term`, `Definition` — plus `User` from
 * task 1. `byIds` is implemented on every source (the relation workhorse that
 * avoids the N+1). The `Definition` source carries a `connection` executor that
 * pages by the canonical term-page keyset; see the connection note in
 * `.patterns/fate-connections.md` for why `Term.definitions` is delivered by
 * the custom `term` resolver (1.0.3's native path doesn't auto-invoke a nested
 * relation's `connection` executor) — the executor stays the single keyset
 * read both paths share. See `.patterns/fate-sources.md`.
 */
import type {SourceDefinition, SourceRegistry} from "@nkzw/fate/server";
import {
	type CommentRow,
	Pano,
	type PostSummaryRow,
	type PostTagRow,
	tagLabel,
} from "../features/pano/Pano";
import {
	type ContributionRow,
	Pasaport,
	type ProfileRow,
	toContributionRow,
	type UserRow,
} from "../features/pasaport/Pasaport";
import {type DefinitionRow, Sozluk, type TermSummaryRow} from "../features/sozluk/Sozluk";
import {Auth} from "../services/Auth";
import type {FateContext} from "./context";
import {fateSource} from "./effect";
import {
	commentDataView,
	contributionDataView,
	definitionDataView,
	postDataView,
	profileDataView,
	tagDataView,
	termDataView,
	userDataView,
} from "./views";

// fate 1.0.3 does not re-export the `DataView` type from `@nkzw/fate/server`
// (only the lowercase `dataView` factory), so recover it from the shape of
// `SourceDefinition['view']` rather than importing the unexported name.
type AnySourceDefinition = SourceDefinition<Record<string, unknown>, unknown>;
type AnyDataView = AnySourceDefinition["view"];

// fate row types — a mapped type satisfies fate's `Record<string, unknown>`
// constraint where the service interface would not (see views.ts).
type UserViewRow = {[K in keyof UserRow]: UserRow[K]};
type DefinitionViewRow = {[K in keyof DefinitionRow]: DefinitionRow[K]};
type TermViewRow = {[K in keyof TermSummaryRow]: TermSummaryRow[K]};
type PostViewRow = {[K in keyof PostSummaryRow]: PostSummaryRow[K]};
type CommentViewRow = {[K in keyof CommentRow]: CommentRow[K]};
type TagViewRow = {[K in keyof PostTagRow]: PostTagRow[K]};
// The `Profile` view row adds the client normalization key `id` (=== `userId`)
// on top of the service `ProfileRow` — mirrors `views.ts`.
type ProfileViewRow = {[K in keyof ProfileRow]: ProfileRow[K]} & {id: string};
type ContributionViewRow = {[K in keyof ContributionRow]: ContributionRow[K]};

const userExecutor = fateSource<UserViewRow>({
	byId: function* (id) {
		const pasaport = yield* Pasaport;
		return yield* pasaport.getUserById(id);
	},
	byIds: function* (ids) {
		const pasaport = yield* Pasaport;
		return yield* pasaport.getUsersByIds(ids);
	},
});

const definitionExecutor = fateSource<DefinitionViewRow>({
	byIds: function* (ids) {
		const sozluk = yield* Sozluk;
		const auth = yield* Auth;
		return yield* sozluk.getDefinitionsByIds(ids, {viewerId: auth.user?.id ?? null});
	},
	// Keyset page over a single term's definitions in the canonical term-page
	// order. fate's cursor for a connection node is its `id` (the default
	// `getCursor`); the service resolves that id to its `(score, createdAt, id)`
	// keyset tuple and fetches the rows that follow it, so a page is a bounded
	// `WHERE … LIMIT` with no skips/dupes. The term slug arrives as a scoped
	// arg (`args.termSlug`) when the connection is invoked as a root list.
	connection: function* (page) {
		const sozluk = yield* Sozluk;
		const auth = yield* Auth;
		const slug = typeof page.args?.termSlug === "string" ? page.args.termSlug : "";
		const result = yield* sozluk.listDefinitionsKeyset(slug, {
			first: page.take,
			...(page.cursor !== undefined ? {after: page.cursor} : {}),
			viewerId: auth.user?.id ?? null,
		});
		return result.rows;
	},
});

const termExecutor = fateSource<TermViewRow>({
	byId: function* (slug) {
		const sozluk = yield* Sozluk;
		const rows = yield* sozluk.getTermSummariesByIds([slug]);
		return rows[0] ?? null;
	},
	byIds: function* (slugs) {
		const sozluk = yield* Sozluk;
		return yield* sozluk.getTermSummariesByIds(slugs);
	},
});

const postExecutor = fateSource<PostViewRow>({
	byId: function* (id) {
		const pano = yield* Pano;
		const auth = yield* Auth;
		const rows = yield* pano.getPostsByIds([id], {viewerId: auth.user?.id ?? null});
		return rows[0] ?? null;
	},
	byIds: function* (ids) {
		const pano = yield* Pano;
		const auth = yield* Auth;
		return yield* pano.getPostsByIds(ids, {viewerId: auth.user?.id ?? null});
	},
});

const commentExecutor = fateSource<CommentViewRow>({
	byIds: function* (ids) {
		const pano = yield* Pano;
		const auth = yield* Auth;
		return yield* pano.getCommentsByIds(ids, {viewerId: auth.user?.id ?? null});
	},
	// Keyset page over a single post's comments in chronological-asc order. fate's
	// connection-node cursor is the comment `id` (the default `getCursor`); the
	// service resolves that id to its `(createdAt, id)` keyset tuple and fetches
	// the rows that follow it, so a page is a bounded `WHERE … LIMIT`. The post id
	// arrives as a scoped arg (`args.postId`) when invoked as a root list.
	connection: function* (page) {
		const pano = yield* Pano;
		const auth = yield* Auth;
		const postId = typeof page.args?.postId === "string" ? page.args.postId : "";
		const result = yield* pano.listCommentsKeyset(postId, {
			first: page.take,
			...(page.cursor !== undefined ? {after: page.cursor} : {}),
			viewerId: auth.user?.id ?? null,
		});
		return result.rows;
	},
});

// Tags are embedded scalars on the post row (no standalone table). The `byIds`
// executor maps tag kinds to `{kind, label}` via the same static label map the
// service uses, so the `Tag` type is fetchable by kind for relation callers;
// `Post.tags` itself rides the pre-built array on the parent row.
const tagExecutor = fateSource<TagViewRow>({
	byIds: function* (kinds) {
		return kinds.map((kind) => ({kind, label: tagLabel(kind)}));
	},
});

// `Profile` is fetched by its `userId` (the immutable per-user id; `username`
// may be null until bootstrap). The root `profile(username)` / `me` resolvers
// are custom queries that build the full `Profile` shape inline, so this `byId`
// exists for relation/by-id callers; it re-aggregates the live counts.
const profileExecutor = fateSource<ProfileViewRow>({
	byId: function* (userId) {
		const pasaport = yield* Pasaport;
		const row = yield* pasaport.lookupProfileById(userId);
		// Stamp the client normalization key `id` (=== `userId`); the service row
		// carries only `userId`.
		return row ? {...row, id: row.userId} : row;
	},
});

// The `Contribution` discriminant feed (ADR 0018). It is only ever paginated
// (never fetched by id as a relation), so the source carries a `connection`
// executor — the single keyset read both the inline-resolver path and a future
// native nested-connection path share. It delegates to `Pasaport.listContributions`
// (the `(createdAt desc, id desc)` keyset) and flattens each `ContributionNode`
// to the flat discriminant row via `toContributionRow`. The author id arrives as
// a scoped arg (`args.authorId`) when invoked as a connection.
const contributionExecutor = fateSource<ContributionViewRow>({
	connection: function* (page) {
		const pasaport = yield* Pasaport;
		const authorId = typeof page.args?.authorId === "string" ? page.args.authorId : "";
		const connection = yield* pasaport.listContributions({
			authorId,
			first: page.take,
			after: page.cursor ?? null,
		});
		return connection.edges.map((edge) => toContributionRow(edge.node));
	},
});

// SourceDefinitions are plain object literals — no factory call. `id` is the PK
// field name (`slug` for Term, `id` for Definition/User), `view` is the base
// data view, `orderBy` matches the service ORDER BY for the connection.
const userSource: AnySourceDefinition = {id: "id", view: userDataView as AnyDataView};
const definitionSource: AnySourceDefinition = {
	id: "id",
	view: definitionDataView as AnyDataView,
	orderBy: [
		{field: "score", direction: "desc"},
		{field: "createdAt", direction: "asc"},
		{field: "id", direction: "asc"},
	],
};
const termSource: AnySourceDefinition = {id: "slug", view: termDataView as AnyDataView};
const postSource: AnySourceDefinition = {
	id: "id",
	view: postDataView as AnyDataView,
	// The Post root-list keyset; the `posts` lists resolver owns the cursor SQL,
	// but the order contract has one home here for if/when fate's native list
	// path is used. Cursor falls back to `id` (the post-feed keyset cursor).
	orderBy: [{field: "id", direction: "desc"}],
};
const commentSource: AnySourceDefinition = {
	id: "id",
	view: commentDataView as AnyDataView,
	orderBy: [
		{field: "createdAt", direction: "asc"},
		{field: "id", direction: "asc"},
	],
};
const tagSource: AnySourceDefinition = {id: "kind", view: tagDataView as AnyDataView};
const profileSource: AnySourceDefinition = {id: "userId", view: profileDataView as AnyDataView};
const contributionSource: AnySourceDefinition = {
	id: "id",
	view: contributionDataView as AnyDataView,
	// = Pasaport.listContributions' ORDER BY; `id` (a global ULID across the
	// three contribution tables) is the final tiebreaker.
	orderBy: [
		{field: "createdAt", direction: "desc"},
		{field: "id", direction: "desc"},
	],
};

// The registry is a plain Map keyed by the SourceDefinition object (identity).
const registry: SourceRegistry<FateContext> = new Map([
	[userSource, userExecutor],
	[definitionSource, definitionExecutor],
	[termSource, termExecutor],
	[postSource, postExecutor],
	[commentSource, commentExecutor],
	[tagSource, tagExecutor],
	[profileSource, profileExecutor],
	[contributionSource, contributionExecutor],
]);

// fate calls getSource with a base or list()-wrapped view; both share
// `typeName`, so resolve by typeName. It must return the *same* SourceDefinition
// object used as the registry key.
const sourcesByType = new Map<string, AnySourceDefinition>(
	[
		userSource,
		definitionSource,
		termSource,
		postSource,
		commentSource,
		tagSource,
		profileSource,
		contributionSource,
	].map((s) => [s.view.typeName, s]),
);

export const sources = {
	getSource: <Item extends Record<string, unknown>>(
		view: AnyDataView | SourceDefinition<Item, unknown>,
	): SourceDefinition<Item, unknown> => {
		const typeName = "view" in view ? view.view.typeName : view.typeName;
		const source = sourcesByType.get(typeName);
		if (!source) {
			throw new Error(`No source registered for '${typeName}'.`);
		}
		return source as SourceDefinition<Item, unknown>;
	},
	registry,
};
