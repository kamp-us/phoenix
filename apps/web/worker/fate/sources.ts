/**
 * Hand-built `SourceResolver` — Effect-backed reads.
 *
 * fate is pure transport (ADR 0016): it never queries D1. Every source
 * executor delegates to an Effect service method through {@link fateSource},
 * so all read logic stays in the domain layer. `createDrizzleSourceAdapter` is
 * banned.
 *
 * `@nkzw/fate/server` does **not** re-export `createSourceDefinition` /
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
 * `byId`/`byIds` are the only executors implemented here — the relation
 * workhorse (avoids the N+1) that also backs live relation masking. Sources
 * carry **no** `connection` executor or `orderBy` contract: fate only reaches
 * `resolveSourceConnection` from a native root `list` (phoenix's `roots` is
 * empty) or the banned Drizzle adapter, so every connection — root *and*
 * nested (`Term.definitions` / `Post.comments` / `Profile.contributions`) — is
 * delivered by a custom resolver in `queries.ts` / `lists.ts` calling the
 * service keyset method directly (ADR 0019). The keyset `ORDER BY` lives in the
 * service; the view `list(view, {orderBy})` mirrors it. See
 * `.patterns/fate-connections.md` and `.patterns/fate-sources.md`.
 */
import type {SourceDefinition, SourceRegistry} from "@nkzw/fate/server";
import {
	type CommentRow,
	Pano,
	type PostSummaryRow,
	type PostTagRow,
	tagLabel,
} from "../features/pano/Pano.ts";
import {Auth} from "../features/pasaport/Auth.ts";
import {Pasaport, type ProfileRow, type UserRow} from "../features/pasaport/Pasaport.ts";
import {type DefinitionRow, Sozluk, type TermSummaryRow} from "../features/sozluk/Sozluk.ts";
import type {FateContext} from "./context.ts";
import {fateSource} from "./effect.ts";
import {
	commentDataView,
	definitionDataView,
	postDataView,
	profileDataView,
	tagDataView,
	termDataView,
	userDataView,
} from "./views.ts";

// `@nkzw/fate/server` does not re-export the `DataView` type (only the
// lowercase `dataView` factory), so recover it from the shape of
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

// SourceDefinitions are plain object literals — no factory call. `id` is the PK
// field name (`slug` for Term, `userId` for Profile, `id` elsewhere), `view` is
// the base data view. No `orderBy`: the keyset `ORDER BY` lives in the service
// methods the custom resolvers call, never in a source `connection` executor
// (none exist — see the file header and ADR 0019).
const userSource: AnySourceDefinition = {id: "id", view: userDataView as AnyDataView};
const definitionSource: AnySourceDefinition = {id: "id", view: definitionDataView as AnyDataView};
const termSource: AnySourceDefinition = {id: "slug", view: termDataView as AnyDataView};
const postSource: AnySourceDefinition = {id: "id", view: postDataView as AnyDataView};
const commentSource: AnySourceDefinition = {id: "id", view: commentDataView as AnyDataView};
const tagSource: AnySourceDefinition = {id: "kind", view: tagDataView as AnyDataView};
const profileSource: AnySourceDefinition = {id: "userId", view: profileDataView as AnyDataView};

// The registry is a plain Map keyed by the SourceDefinition object (identity).
const registry: SourceRegistry<FateContext> = new Map([
	[userSource, userExecutor],
	[definitionSource, definitionExecutor],
	[termSource, termExecutor],
	[postSource, postExecutor],
	[commentSource, commentExecutor],
	[tagSource, tagExecutor],
	[profileSource, profileExecutor],
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
