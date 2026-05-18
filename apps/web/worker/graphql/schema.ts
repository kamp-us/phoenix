import {Effect} from "effect";
import {
	GraphQLBoolean,
	GraphQLEnumType,
	GraphQLError,
	GraphQLID,
	GraphQLInputObjectType,
	GraphQLInt,
	GraphQLInterfaceType,
	GraphQLList,
	GraphQLNonNull,
	GraphQLObjectType,
	GraphQLSchema,
	GraphQLString,
	GraphQLUnionType,
	lexicographicSortSchema,
	printSchema,
} from "graphql";
import {decodeNodeId, encodeNodeId, extractLocalId} from "../../src/relay/encodeNodeId";
import {type LandingStats, readLandingStats} from "../features/landingStatsReader";
import {
	ALLOWED_POST_TAG_KINDS,
	type CommentConnectionPage,
	type CommentRow,
	Pano,
	type PostConnectionPage,
	type PostPage,
	type PostSort,
	type PostSummaryRow,
	type PostTagRow,
} from "../features/pano/Pano";
import {
	type ContributionConnection,
	type ContributionNode,
	Pasaport,
	type ProfileRow,
} from "../features/pasaport/Pasaport";
import {
	type DefinitionConnectionPage,
	type DefinitionRow,
	type ListSort,
	Sozluk,
	type TermConnectionPage,
	type TermPage,
	type TermSummaryRow,
} from "../features/sozluk/Sozluk";
import {Auth, CloudflareEnv} from "../services";
import {resolver} from "./resolver";

const HealthType = new GraphQLObjectType({
	name: "Health",
	fields: {
		status: {type: new GraphQLNonNull(GraphQLString)},
		environment: {type: new GraphQLNonNull(GraphQLString)},
	},
});

/**
 * Relay `Node` interface. Every entity that a
 * Relay client can refetch via `@refetchable` or load via the top-level
 * `node(id)` query implements `Node` and exposes a globally-unique `id`.
 *
 * Concrete types stamp a `__typename` property on the rows they return from
 * the {@link nodeResolver} dispatch path; everywhere else, `resolveType`
 * inspects whichever per-entity discriminator is most natural (slug / kind).
 */
const NodeInterfaceType = new GraphQLInterfaceType({
	name: "Node",
	fields: {
		id: {type: new GraphQLNonNull(GraphQLID)},
	},
	resolveType: (value: {__typename?: string}) => value.__typename,
});

/**
 * Stamp a `__typename` on a row before returning it from the `node(id)`
 * dispatch — the {@link NodeInterfaceType} `resolveType` reads it to pick
 * the concrete GraphQL type. Plain reads from query fields like `term(slug)`
 * already know their concrete type, so they don't need this.
 */
function asNode<T extends object>(typename: string, value: T): T & {__typename: string} {
	return Object.assign({__typename: typename}, value);
}

const UserType = new GraphQLObjectType({
	name: "User",
	interfaces: () => [NodeInterfaceType],
	fields: {
		// Relay global id: base64 of `User:${userId}`. Local id is recoverable
		// via `decodeNodeId` (or `extractLocalId`, lenient) at any mutation
		// entry point that takes a `User` reference.
		id: {
			type: new GraphQLNonNull(GraphQLID),
			resolve: (u: {id: string}) => encodeNodeId("User", u.id),
		},
		email: {type: new GraphQLNonNull(GraphQLString)},
		name: {type: GraphQLString},
		image: {type: GraphQLString},
		// Public handle. NULL until the user completes the bootstrap step on
		// first sign-in — the SPA shows the username form when this is null.
		username: {type: GraphQLString},
	},
});

const DefinitionType = new GraphQLObjectType<DefinitionRow>({
	name: "Definition",
	interfaces: () => [NodeInterfaceType],
	fields: {
		id: {
			type: new GraphQLNonNull(GraphQLID),
			resolve: (d) => encodeNodeId("Definition", d.id),
		},
		body: {type: new GraphQLNonNull(GraphQLString)},
		author: {type: new GraphQLNonNull(GraphQLString)},
		/**
		 * Pasaport user id of the author. Powers the frontend's
		 * "is the current user the author?" check that gates edit / delete
		 * affordances (T6).
		 */
		authorId: {type: new GraphQLNonNull(GraphQLID)},
		score: {type: new GraphQLNonNull(GraphQLInt)},
		createdAt: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (d) => d.createdAt.toISOString(),
		},
		updatedAt: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (d) => d.updatedAt.toISOString(),
		},
		/**
		 * `1` if the requesting user has upvoted this definition; `null` if the
		 * user is signed-out or hasn't voted. Looked up in `PHOENIX_DB.user_vote`
		 * (cross-product MV maintained by the `VoteRecorded` projection step).
		 *
		 * The `parent.id` is the definition id; `targetKind = 'definition'` is
		 * fixed. Signed-out short-circuits without touching D1.
		 *
		 * Vote mutation resolvers stamp `myVote` directly on the returned row
		 * (authoritative from the per-term Agent's vote-table state) so the
		 * field doesn't race against the cross-product projection landing. We
		 * honor that stamped value when present; otherwise we look up the MV.
		 */
		myVote: {
			type: GraphQLInt,
			resolve: resolver(function* (parent: DefinitionRow) {
				const stamped = (parent as {myVote?: number | null}).myVote;
				if (stamped !== undefined) return stamped;
				const auth = yield* Auth;
				if (!auth.user) return null;
				const sozluk = yield* Sozluk;
				return yield* sozluk.readMyVote({
					userId: auth.user.id,
					targetKind: "definition",
					targetId: parent.id,
				});
			}),
		},
	},
});

/**
 * Single Term type backs both list (TermSummaryRow from D1) and detail
 * (TermPage from per-term Agent) queries. Fields specific to one shape
 * (excerpt, definitions, firstAt, lastEdit) resolve to null / empty when
 * the source doesn't carry them — matches GraphQL execution: clients only
 * request what they need.
 */
const TermType: GraphQLObjectType = new GraphQLObjectType<TermPage | TermSummaryRow>({
	name: "Term",
	interfaces: () => [NodeInterfaceType],
	fields: () => ({
		id: {
			type: new GraphQLNonNull(GraphQLID),
			resolve: (t) => encodeNodeId("Term", t.slug),
		},
		slug: {type: new GraphQLNonNull(GraphQLString)},
		title: {type: new GraphQLNonNull(GraphQLString)},
		count: {
			type: new GraphQLNonNull(GraphQLInt),
			resolve: (s) => ("count" in s ? s.count : s.totalDefinitions),
		},
		totalScore: {
			type: new GraphQLNonNull(GraphQLInt),
			resolve: (s) => s.totalScore,
		},
		excerpt: {
			type: GraphQLString,
			resolve: (s) => ("excerpt" in s ? s.excerpt : null),
		},
		firstAt: {
			type: GraphQLString,
			resolve: (s) => {
				if (!("firstAt" in s) || !s.firstAt) return null;
				return s.firstAt.toISOString();
			},
		},
		lastEdit: {
			type: GraphQLString,
			resolve: (s) => {
				if (!("lastEdit" in s) || !s.lastEdit) return null;
				return s.lastEdit.toISOString();
			},
		},
		/**
		 * Sozluk home `TermRowFragment` projections.
		 *
		 * `firstLetter` powers the alphabet pivot ribbon — the row exposes
		 * the column directly off `term_summary` so the SPA doesn't have to
		 * re-derive the lower-cased first character (Turkish-locale safe;
		 * the projection writes it). For a `TermPage` source (per-term DO
		 * read; the summary fields aren't materialized there) we lower-case
		 * the title client-side as a graceful fallback.
		 *
		 * `definitionCount` and `lastActivityAt` mirror the row fields
		 * `count` / `lastEdit` but with names matching the home-row's
		 * intent (count of live definitions / last activity timestamp).
		 * Keeping them as separate field names follows the AC literally
		 * and lets the row fragment read them under the names it asks
		 * for; resolvers normalize across both source shapes.
		 */
		firstLetter: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (s) => {
				if ("firstLetter" in s && s.firstLetter) return s.firstLetter;
				return (s.title?.[0] ?? "").toLowerCase();
			},
		},
		definitionCount: {
			type: new GraphQLNonNull(GraphQLInt),
			resolve: (s) => ("definitionCount" in s ? s.definitionCount : s.totalDefinitions),
		},
		lastActivityAt: {
			type: GraphQLString,
			resolve: (s) => {
				if ("lastActivityAt" in s) {
					return s.lastActivityAt ? s.lastActivityAt.toISOString() : null;
				}
				if ("lastEdit" in s && s.lastEdit) return s.lastEdit.toISOString();
				return null;
			},
		},
		/**
		 * Connection-shaped definition list.
		 * The canonical read path for `SozlukTermPage`. Replaces the legacy
		 * flat-array `definitions: [Definition!]!` field. Relay's `@connection`
		 * key convention requires the field name to match the suffix of the
		 * key (`<Component>_<fieldName>`), and the SPA's only consumer is
		 * the term page.
		 *
		 * Cursor pagination is keyset on the definition id (forge ULID;
		 * lex-sortable) over the per-term Agent's score-DESC materialized
		 * order. `LoadMoreButton` reads `pageInfo.hasNextPage`; `totalCount`
		 * reflects the materialized live-only count.
		 */
		definitions: {
			type: new GraphQLNonNull(DefinitionConnectionType),
			args: {
				first: {type: GraphQLInt},
				after: {type: GraphQLString},
			},
			resolve: resolver(function* (
				parent: TermPage | TermSummaryRow,
				args: {first?: number | null; after?: string | null},
			) {
				const sozluk = yield* Sozluk;
				return yield* sozluk.listDefinitionsConnection(parent.slug, {
					...(args.first != null ? {first: args.first} : {}),
					...(args.after ? {after: args.after} : {}),
				});
			}),
		},
	}),
});

/* -------------------------------------------------------------------------- */
/* Definition connection                                                       */
/* -------------------------------------------------------------------------- */

const DefinitionEdgeType = new GraphQLObjectType<{cursor: string; node: DefinitionRow}>({
	name: "DefinitionEdge",
	fields: () => ({
		cursor: {type: new GraphQLNonNull(GraphQLString)},
		node: {type: new GraphQLNonNull(DefinitionType)},
	}),
});

const DefinitionConnectionType = new GraphQLObjectType<DefinitionConnectionPage>({
	name: "DefinitionConnection",
	fields: () => ({
		edges: {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(DefinitionEdgeType))),
			resolve: (page) => page.rows.map((row) => ({cursor: row.id, node: row})),
		},
		pageInfo: {
			type: new GraphQLNonNull(PageInfoType),
			resolve: (page) => ({
				hasNextPage: page.hasNextPage,
				endCursor: page.endCursor,
			}),
		},
		totalCount: {
			type: new GraphQLNonNull(GraphQLInt),
			resolve: (page) => page.totalCount,
		},
	}),
});

/**
 * `deleteDefinition` mutation payload. Returns
 * the deleted definition's Relay global id so the SPA can `@deleteRecord`
 * it out of the store; connection edges referencing the gone record auto-
 * clear. Mirrors the `deletedPostId @deleteRecord` shape from `deletePost`.
 * No two-shape payload here — a soft-deleted definition simply
 * disappears (no reply-aware placeholder like comments).
 */
const DeleteDefinitionPayloadType = new GraphQLObjectType<{
	deletedDefinitionId: string;
}>({
	name: "DeleteDefinitionPayload",
	fields: () => ({
		deletedDefinitionId: {type: new GraphQLNonNull(GraphQLID)},
	}),
});

const TermSortEnum = new GraphQLEnumType({
	name: "TermSort",
	values: {
		recent: {value: "recent"},
		popular: {value: "popular"},
	},
});

/* -------------------------------------------------------------------------- */
/* Term connection                                                             */
/* -------------------------------------------------------------------------- */

const TermEdgeType = new GraphQLObjectType<{cursor: string; node: TermSummaryRow}>({
	name: "TermEdge",
	fields: () => ({
		cursor: {type: new GraphQLNonNull(GraphQLString)},
		node: {type: new GraphQLNonNull(TermType)},
	}),
});

const TermConnectionType = new GraphQLObjectType<TermConnectionPage>({
	name: "TermConnection",
	fields: () => ({
		edges: {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TermEdgeType))),
			resolve: (page) => page.rows.map((row) => ({cursor: row.slug, node: row})),
		},
		pageInfo: {
			type: new GraphQLNonNull(PageInfoType),
			resolve: (page) => ({
				hasNextPage: page.hasNextPage,
				endCursor: page.endCursor,
			}),
		},
		totalCount: {
			type: new GraphQLNonNull(GraphQLInt),
			resolve: (page) => page.totalCount,
		},
	}),
});

const TagType = new GraphQLObjectType<PostTagRow>({
	name: "Tag",
	fields: {
		kind: {type: new GraphQLNonNull(GraphQLString)},
		label: {type: new GraphQLNonNull(GraphQLString)},
	},
});

/**
 * Single Post type backs list (PostSummaryRow from D1), detail (PostPage from
 * per-post DO), and mutation results (VoteOnPostResult from per-post Agent).
 * The shapes overlap on every required field; resolvers normalize at their
 * boundary so the type only sees rows that satisfy this contract.
 */
const PostType = new GraphQLObjectType<PostSummaryRow | PostPage>({
	name: "Post",
	interfaces: () => [NodeInterfaceType],
	fields: () => ({
		id: {
			type: new GraphQLNonNull(GraphQLID),
			resolve: (p) => encodeNodeId("Post", p.id),
		},
		slug: {type: GraphQLString},
		title: {type: new GraphQLNonNull(GraphQLString)},
		url: {type: GraphQLString},
		host: {type: GraphQLString},
		body: {type: GraphQLString},
		author: {type: new GraphQLNonNull(GraphQLString)},
		/**
		 * Pasaport user id of the author. Powers the frontend's
		 * "is the current user the author?" check that gates edit / delete
		 * affordances (T9). Mirrors `Definition.authorId` from T6.
		 */
		authorId: {type: new GraphQLNonNull(GraphQLID)},
		score: {type: new GraphQLNonNull(GraphQLInt)},
		commentCount: {type: new GraphQLNonNull(GraphQLInt)},
		createdAt: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (p) => p.createdAt.toISOString(),
		},
		updatedAt: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (p) => {
				const u = (p as {updatedAt?: Date}).updatedAt;
				return (u ?? p.createdAt).toISOString();
			},
		},
		tags: {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TagType))),
			resolve: (p) => p.tags,
		},
		/**
		 * `1` if the requesting user has upvoted this post; `null` if signed-out
		 * or hasn't voted. Looked up in `PHOENIX_DB.user_vote` (cross-product MV
		 * maintained by the `VoteRecorded` projection step). Symmetric with
		 * `Definition.myVote` (T5). Signed-out short-circuits without touching D1.
		 *
		 * Vote mutation resolvers stamp `myVote` directly on the returned row
		 * (authoritative from the per-post Agent's vote-table state) so the field
		 * doesn't race against the cross-product projection landing. We honor that
		 * stamped value when present; otherwise we look up the MV.
		 */
		myVote: {
			type: GraphQLInt,
			resolve: resolver(function* (parent: PostSummaryRow | PostPage) {
				const stamped = (parent as {myVote?: number | null}).myVote;
				if (stamped !== undefined) return stamped;
				const auth = yield* Auth;
				if (!auth.user) return null;
				const sozluk = yield* Sozluk;
				return yield* sozluk.readMyVote({
					userId: auth.user.id,
					targetKind: "post",
					targetId: parent.id,
				});
			}),
		},
		/**
		 * Connection-shaped comment list.
		 * Canonical read path for the post-detail page; replaced the legacy
		 * top-level `postComments(postId)` flat-array field.
		 *
		 * Cursor pagination is keyset on the comment id (forge ULID;
		 * lex-sortable, matches chronological-asc). The `LoadMoreButton` reads
		 * `pageInfo.hasNextPage`; `totalCount` reflects the materialized
		 * post-reply-aware list length.
		 */
		comments: {
			type: new GraphQLNonNull(CommentConnectionType),
			args: {
				first: {type: GraphQLInt},
				after: {type: GraphQLString},
			},
			resolve: resolver(function* (
				parent: PostSummaryRow | PostPage,
				args: {first?: number | null; after?: string | null},
			) {
				const pano = yield* Pano;
				return yield* pano.listCommentsConnection(parent.id, {
					...(args.first != null ? {first: args.first} : {}),
					...(args.after ? {after: args.after} : {}),
				});
			}),
		},
	}),
});

/* -------------------------------------------------------------------------- */
/* Comment connection                                                          */
/* -------------------------------------------------------------------------- */

const CommentEdgeType = new GraphQLObjectType<{cursor: string; node: CommentRow}>({
	name: "CommentEdge",
	fields: () => ({
		cursor: {type: new GraphQLNonNull(GraphQLString)},
		node: {type: new GraphQLNonNull(CommentType)},
	}),
});

const CommentConnectionType = new GraphQLObjectType<CommentConnectionPage>({
	name: "CommentConnection",
	fields: () => ({
		edges: {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(CommentEdgeType))),
			resolve: (page) => page.rows.map((row) => ({cursor: row.id, node: row})),
		},
		pageInfo: {
			type: new GraphQLNonNull(PageInfoType),
			resolve: (page) => ({
				hasNextPage: page.hasNextPage,
				endCursor: page.endCursor,
			}),
		},
		totalCount: {
			type: new GraphQLNonNull(GraphQLInt),
			resolve: (page) => page.totalCount,
		},
	}),
});

/**
 * Two-shape mutation payload for `deleteComment`.
 * Exactly one of `deletedCommentId` / `comment` is non-null per call:
 *
 *  - **Leaf path** — comment had no live children. `deletedCommentId` is the
 *    Relay global id; the FE `@deleteRecord`s it out of the store, the
 *    connection edge auto-clears.
 *  - **Parent-with-replies path** — comment had at least one live child. The
 *    server returns the same `Comment` with `body = '[silindi]'` and
 *    `deletedAt` set; Relay's automatic store update merges the new scalars
 *    into the existing `Comment:<global-id>` record. The row stays in the
 *    connection so the thread shape is preserved.
 */
const DeleteCommentPayloadType = new GraphQLObjectType<{
	deletedCommentId: string | null;
	comment: CommentRow | null;
}>({
	name: "DeleteCommentPayload",
	fields: () => ({
		deletedCommentId: {type: GraphQLID},
		comment: {type: CommentType},
	}),
});

const CommentType = new GraphQLObjectType<CommentRow>({
	name: "Comment",
	interfaces: () => [NodeInterfaceType],
	fields: {
		id: {
			type: new GraphQLNonNull(GraphQLID),
			resolve: (c) => encodeNodeId("Comment", c.id),
		},
		parentId: {type: GraphQLID},
		author: {type: new GraphQLNonNull(GraphQLString)},
		/**
		 * Pasaport user id of the comment's author. Powers the frontend's
		 * "is the current user the author?" check that gates edit / delete
		 * affordances (T12). Mirrors `Definition.authorId` (T6) and
		 * `Post.authorId` (T9).
		 */
		authorId: {type: new GraphQLNonNull(GraphQLID)},
		body: {type: new GraphQLNonNull(GraphQLString)},
		score: {type: new GraphQLNonNull(GraphQLInt)},
		createdAt: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (c) => c.createdAt.toISOString(),
		},
		updatedAt: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (c) => {
				const u = (c as {updatedAt?: Date}).updatedAt;
				return (u ?? c.createdAt).toISOString();
			},
		},
		/**
		 * Soft-delete timestamp. `null` for live
		 * comments; ISO string when the comment was soft-deleted but still
		 * appears in the tree as a `[silindi]` placeholder (parent-with-replies
		 * path). The leaf-delete path removes the row entirely so it never
		 * surfaces here. The SPA reads this typed flag instead of the fragile
		 * body-string match against `[silindi]`.
		 */
		deletedAt: {
			type: GraphQLString,
			resolve: (c) => {
				const d = (c as {deletedAt?: Date | null}).deletedAt;
				return d ? d.toISOString() : null;
			},
		},
		/**
		 * `1` if the requesting user has upvoted this comment; `null` if the
		 * user is signed-out or hasn't voted. Looked up in `PHOENIX_DB.user_vote`
		 * (cross-product MV maintained by the `VoteRecorded` projection step).
		 *
		 * Symmetric with `Definition.myVote` (T5) and `Post.myVote` (T8).
		 * Signed-out short-circuits without touching D1.
		 *
		 * Vote mutation resolvers stamp `myVote` directly on the returned row
		 * (authoritative from the per-post Agent's vote-table state) so the
		 * field doesn't race against the cross-product projection landing.
		 */
		myVote: {
			type: GraphQLInt,
			resolve: resolver(function* (parent: CommentRow) {
				const stamped = (parent as {myVote?: number | null}).myVote;
				if (stamped !== undefined) return stamped;
				const auth = yield* Auth;
				if (!auth.user) return null;
				const sozluk = yield* Sozluk;
				return yield* sozluk.readMyVote({
					userId: auth.user.id,
					targetKind: "comment",
					targetId: parent.id,
				});
			}),
		},
	},
});

const PostSortEnum = new GraphQLEnumType({
	name: "PostSort",
	values: {
		hot: {value: "hot"},
		new: {value: "new"},
		top: {value: "top"},
		discuss: {value: "discuss"},
	},
});

/* -------------------------------------------------------------------------- */
/* Profile contributions feed (T14)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Tagged-union node carried by the `ContributionConnection`. Each variant
 * narrows on `__typename`; resolveType inspects the runtime `kind` literal
 * the reader stamps on each row.
 */
const DefinitionContributionType = new GraphQLObjectType<ContributionNode>({
	name: "DefinitionContribution",
	fields: {
		kind: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: () => "definition",
		},
		id: {type: new GraphQLNonNull(GraphQLID)},
		score: {type: new GraphQLNonNull(GraphQLInt)},
		createdAt: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (n) => n.createdAt.toISOString(),
		},
		bodyExcerpt: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (n) => (n.kind === "definition" ? n.bodyExcerpt : ""),
		},
		termSlug: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (n) => (n.kind === "definition" ? n.termSlug : ""),
		},
		termTitle: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (n) => (n.kind === "definition" ? n.termTitle : ""),
		},
	},
});

const PostContributionType = new GraphQLObjectType<ContributionNode>({
	name: "PostContribution",
	fields: {
		kind: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: () => "post",
		},
		id: {type: new GraphQLNonNull(GraphQLID)},
		score: {type: new GraphQLNonNull(GraphQLInt)},
		createdAt: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (n) => n.createdAt.toISOString(),
		},
		title: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (n) => (n.kind === "post" ? n.title : ""),
		},
		slug: {
			type: GraphQLString,
			resolve: (n) => (n.kind === "post" ? n.slug : null),
		},
		bodyExcerpt: {
			type: GraphQLString,
			resolve: (n) => (n.kind === "post" ? n.bodyExcerpt : null),
		},
	},
});

const CommentContributionType = new GraphQLObjectType<ContributionNode>({
	name: "CommentContribution",
	fields: {
		kind: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: () => "comment",
		},
		id: {type: new GraphQLNonNull(GraphQLID)},
		score: {type: new GraphQLNonNull(GraphQLInt)},
		createdAt: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (n) => n.createdAt.toISOString(),
		},
		bodyExcerpt: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (n) => (n.kind === "comment" ? n.bodyExcerpt : ""),
		},
		postId: {
			type: new GraphQLNonNull(GraphQLID),
			resolve: (n) => (n.kind === "comment" ? n.postId : ""),
		},
		postTitle: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (n) => (n.kind === "comment" ? n.postTitle : ""),
		},
	},
});

const ProfileContributionType = new GraphQLUnionType({
	name: "ProfileContribution",
	types: [DefinitionContributionType, PostContributionType, CommentContributionType],
	resolveType: (value: ContributionNode) => {
		switch (value.kind) {
			case "definition":
				return "DefinitionContribution";
			case "post":
				return "PostContribution";
			case "comment":
				return "CommentContribution";
		}
	},
});

const ContributionEdgeType = new GraphQLObjectType<{cursor: string; node: ContributionNode}>({
	name: "ContributionEdge",
	fields: {
		cursor: {type: new GraphQLNonNull(GraphQLString)},
		node: {type: new GraphQLNonNull(ProfileContributionType)},
	},
});

/**
 * Relay-spec `PageInfo`. The fields are the
 * full Relay set so future bidirectional pagination can be wired in
 * without an SDL break. Today's connection resolvers only
 * populate `hasNextPage` / `endCursor`; the others default to safe values
 * (`hasPreviousPage: false`, `startCursor: null`) so the SDL contract
 * holds without forcing every reader to manufacture them.
 */
interface PageInfoLike {
	hasNextPage: boolean;
	endCursor: string | null;
	hasPreviousPage?: boolean;
	startCursor?: string | null;
}
const PageInfoType = new GraphQLObjectType<PageInfoLike>({
	name: "PageInfo",
	fields: {
		hasNextPage: {type: new GraphQLNonNull(GraphQLBoolean)},
		hasPreviousPage: {
			type: new GraphQLNonNull(GraphQLBoolean),
			resolve: (p) => p.hasPreviousPage ?? false,
		},
		startCursor: {
			type: GraphQLString,
			resolve: (p) => p.startCursor ?? null,
		},
		endCursor: {type: GraphQLString},
	},
});

const ContributionConnectionType = new GraphQLObjectType<ContributionConnection>({
	name: "ContributionConnection",
	fields: {
		edges: {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ContributionEdgeType))),
		},
		pageInfo: {
			type: new GraphQLNonNull(PageInfoType),
			resolve: (c) => ({hasNextPage: c.hasNextPage, endCursor: c.endCursor}),
		},
		totalCount: {
			type: new GraphQLNonNull(GraphQLInt),
			resolve: (c) => c.totalCount,
		},
	},
});

/* -------------------------------------------------------------------------- */
/* Pano feed connection                                                        */
/* -------------------------------------------------------------------------- */

const PostEdgeType = new GraphQLObjectType<{cursor: string; node: PostSummaryRow}>({
	name: "PostEdge",
	fields: {
		cursor: {type: new GraphQLNonNull(GraphQLString)},
		node: {type: new GraphQLNonNull(PostType)},
	},
});

const PostConnectionType = new GraphQLObjectType<PostConnectionPage>({
	name: "PostConnection",
	fields: {
		edges: {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PostEdgeType))),
			resolve: (page) => page.rows.map((row) => ({cursor: row.id, node: row})),
		},
		pageInfo: {
			type: new GraphQLNonNull(PageInfoType),
			resolve: (page) => ({
				hasNextPage: page.hasNextPage,
				endCursor: page.endCursor,
			}),
		},
		totalCount: {
			type: new GraphQLNonNull(GraphQLInt),
			resolve: (page) => page.totalCount,
		},
	},
});

const ProfileType = new GraphQLObjectType<ProfileRow>({
	name: "Profile",
	interfaces: () => [NodeInterfaceType],
	fields: {
		// Relay global id keyed off `userId` — that's the immutable
		// per-user identifier; `username` may be NULL until bootstrap.
		id: {
			type: new GraphQLNonNull(GraphQLID),
			resolve: (p) => encodeNodeId("Profile", p.userId),
		},
		user: {
			type: new GraphQLNonNull(UserType),
			resolve: (p) => ({
				id: p.userId,
				email: "",
				name: p.displayName,
				image: p.image,
				username: p.username,
			}),
		},
		totalKarma: {type: new GraphQLNonNull(GraphQLInt)},
		definitionCount: {type: new GraphQLNonNull(GraphQLInt)},
		postCount: {type: new GraphQLNonNull(GraphQLInt)},
		commentCount: {type: new GraphQLNonNull(GraphQLInt)},
		contributions: {
			type: new GraphQLNonNull(ContributionConnectionType),
			args: {
				after: {type: GraphQLString},
				first: {type: GraphQLInt},
			},
			resolve: resolver(function* (
				parent: ProfileRow,
				args: {after?: string | null; first?: number | null},
			) {
				const pasaport = yield* Pasaport;
				return yield* pasaport.listContributions({
					authorId: parent.userId,
					after: args.after ?? null,
					first: args.first ?? 20,
				});
			}),
		},
	},
});

/* -------------------------------------------------------------------------- */
/* Landing stats                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Single object backing the landing-page stats card. Sourced from the
 * `sozluk_stats` + `pano_stats` single-row aggregates in `PHOENIX_DB`,
 * maintained inline by the per-feature D1 writer modules (ADR 0009), plus a
 * cross-product distinct-author union. `version` is the build tag the SPA
 * renders alongside the counts — currently hardcoded.
 */
const LandingStatsType = new GraphQLObjectType<LandingStats & {version: string}>({
	name: "LandingStats",
	fields: {
		totalDefinitions: {type: new GraphQLNonNull(GraphQLInt)},
		totalPosts: {type: new GraphQLNonNull(GraphQLInt)},
		totalComments: {type: new GraphQLNonNull(GraphQLInt)},
		totalAuthors: {type: new GraphQLNonNull(GraphQLInt)},
		version: {type: new GraphQLNonNull(GraphQLString)},
	},
});

const PHOENIX_BUILD_VERSION = "v0.3";

const QueryType = new GraphQLObjectType({
	name: "Query",
	fields: {
		/**
		 * Relay `node(id)` dispatch. Decodes a
		 * global id into `(typename, localId)` and routes to the right
		 * per-atom Agent or D1 reader. Returns `null` for any unresolved
		 * id rather than throwing — matches Relay's expectation for a
		 * `Node` lookup that can legitimately miss.
		 *
		 * Definition / Comment lookups walk through the parent atom (term
		 * for Definition, post for Comment) because the per-atom Agent is
		 * the source of truth for the full row shape; the cross-product
		 * MV only carries excerpts. The walk is one D1 lookup + one DO
		 * RPC — fine for the rare `node()` access pattern (refetches and
		 * direct deeplinks); page reads still go through their dedicated
		 * top-level fields.
		 */
		node: {
			type: NodeInterfaceType,
			args: {id: {type: new GraphQLNonNull(GraphQLID)}},
			resolve: resolver(function* (_source, args: {id: string}) {
				let decoded: ReturnType<typeof decodeNodeId>;
				try {
					decoded = decodeNodeId(args.id);
				} catch {
					// Unresolvable id — surface as null rather than a 500.
					return null;
				}
				switch (decoded.typename) {
					case "Term": {
						const sozluk = yield* Sozluk;
						const term = yield* sozluk.getTerm(decoded.id);
						return term ? asNode("Term", term) : null;
					}
					case "Post": {
						const pano = yield* Pano;
						const post = yield* pano.getPost(decoded.id);
						return post ? asNode("Post", post) : null;
					}
					case "Definition": {
						const sozluk = yield* Sozluk;
						const slug = yield* sozluk.lookupDefinitionTermSlug(decoded.id);
						if (!slug) return null;
						const term = yield* sozluk.getTerm(slug);
						const def = term?.definitions.find((d) => d.id === decoded.id) ?? null;
						return def ? asNode("Definition", def) : null;
					}
					case "Comment": {
						const pano = yield* Pano;
						const row = yield* pano.getCommentRow(decoded.id);
						if (!row) return null;
						// Reply-aware projection: a row with `deletedAt` set is the
						// parent-with-replies placeholder; the SPA renders it as
						// `[silindi]`. Leaf-deleted rows are removed from
						// `comment_view` entirely so they never resolve here.
						const c = row.deletedAt
							? {
									id: row.id,
									parentId: row.parentId,
									author: "",
									authorId: "",
									body: "[silindi]",
									score: row.score,
									createdAt: row.createdAt ?? new Date(0),
									updatedAt: row.updatedAt ?? row.createdAt ?? new Date(0),
									deletedAt: row.deletedAt,
								}
							: {
									id: row.id,
									parentId: row.parentId,
									author: row.authorName,
									authorId: row.authorId,
									body: row.body,
									score: row.score,
									createdAt: row.createdAt ?? new Date(0),
									updatedAt: row.updatedAt ?? row.createdAt ?? new Date(0),
									deletedAt: null,
								};
						return asNode("Comment", c);
					}
					case "User": {
						const pasaport = yield* Pasaport;
						const user = yield* pasaport.getUserById(decoded.id);
						return user ? asNode("User", user) : null;
					}
					case "Profile": {
						const pasaport = yield* Pasaport;
						const profile = yield* pasaport.lookupProfileById(decoded.id);
						return profile ? asNode("Profile", profile) : null;
					}
				}
			}),
		},
		health: {
			type: new GraphQLNonNull(HealthType),
			resolve: resolver(function* () {
				const env = yield* CloudflareEnv;
				return {status: "ok", environment: env.ENVIRONMENT};
			}),
		},
		me: {
			type: UserType,
			resolve: resolver(function* () {
				const auth = yield* Auth;
				if (!auth.user) return null;
				const pasaport = yield* Pasaport;
				const fresh = yield* pasaport.getUserById(auth.user.id);
				if (!fresh) {
					return {
						id: auth.user.id,
						email: auth.user.email,
						name: auth.user.name,
						image: auth.user.image,
						username: null,
					};
				}
				return fresh;
			}),
		},
		/**
		 * Sozluk home terms connection. Replaces
		 * the legacy flat-array `terms(sort, limit)` field. The connection
		 * shape unlocks Relay's `@connection`-keyed updaters and future
		 * `usePaginationFragment` usage on the home (currently first-page-only;
		 * the shape is future-proofed).
		 *
		 * Cursor is the term slug (primary key of `term_summary`,
		 * lex-sortable). `sort` accepts `recent` and `popular` (the existing
		 * vocabulary; `TermSort` enum unchanged).
		 */
		terms: {
			type: new GraphQLNonNull(TermConnectionType),
			args: {
				sort: {type: TermSortEnum},
				first: {type: GraphQLInt},
				after: {type: GraphQLString},
			},
			resolve: resolver(function* (
				_source,
				args: {sort?: ListSort; first?: number | null; after?: string | null},
			) {
				const sozluk = yield* Sozluk;
				return yield* sozluk.listTermSummariesConnection({
					...(args.sort ? {sort: args.sort} : {}),
					...(args.first != null ? {first: args.first} : {}),
					...(args.after ? {after: args.after} : {}),
				});
			}),
		},
		term: {
			type: TermType,
			args: {slug: {type: new GraphQLNonNull(GraphQLString)}},
			resolve: resolver(function* (_source, args: {slug: string}) {
				const sozluk = yield* Sozluk;
				return yield* sozluk.getTerm(args.slug);
			}),
		},
		/**
		 * Pano feed connection. Replaces the
		 * legacy flat-array `posts(sort, limit, host)` field. The connection
		 * shape unlocks Relay's idiomatic `usePaginationFragment` +
		 * `@connection` mutation updaters.
		 *
		 * Cursor is the post id (forge ULID; lex-sortable). The reader resolves
		 * the cursor row once per page to support keyset pagination across
		 * non-monotonic sort keys (`hot_score`, `score`, `comment_count`); for
		 * the `new` sort it shortcuts to a direct id comparison.
		 */
		posts: {
			type: new GraphQLNonNull(PostConnectionType),
			args: {
				sort: {type: PostSortEnum},
				host: {type: GraphQLString},
				first: {type: GraphQLInt},
				after: {type: GraphQLString},
			},
			resolve: resolver(function* (
				_source,
				args: {
					sort?: PostSort;
					host?: string | null;
					first?: number | null;
					after?: string | null;
				},
			) {
				const pano = yield* Pano;
				return yield* pano.listPostsConnection({
					...(args.sort ? {sort: args.sort} : {}),
					...(args.first != null ? {first: args.first} : {}),
					...(args.after ? {after: args.after} : {}),
					...(args.host ? {host: args.host} : {}),
				});
			}),
		},
		post: {
			type: PostType,
			args: {idOrSlug: {type: new GraphQLNonNull(GraphQLString)}},
			resolve: resolver(function* (_source, args: {idOrSlug: string}) {
				// Accept either a Relay global id (`Post:<localId>` base64),
				// a raw local post id, or a slug. After the connection
				// migration, the SPA hands back `Post.id` (the global id) when
				// it navigates to /pano/<id>; we extract the local id so the
				// D1 lookup hits the right row.
				const key = extractLocalId(args.idOrSlug, "Post");
				const pano = yield* Pano;
				return yield* pano.getPost(key);
			}),
		},
		/**
		 * Public profile by username (T14). Returns `null` for an unknown
		 * username — the SPA renders the 404 page in that case. Aggregates
		 * (`totalKarma`, `*Count`) read from the `user_profile` MV (karma)
		 * and the per-kind view tables (counts derived live, see
		 * `Pasaport.lookupProfile`). The `contributions` field
		 * resolves the interleaved feed; pagination is keyset on
		 * `(created_at DESC, id DESC)` via a composite ULID cursor.
		 */
		profile: {
			type: ProfileType,
			args: {username: {type: new GraphQLNonNull(GraphQLString)}},
			resolve: resolver(function* (_source, args: {username: string}) {
				const pasaport = yield* Pasaport;
				return yield* pasaport.lookupProfile(args.username);
			}),
		},
		/**
		 * Landing-page stats card. Reads the single-row aggregates from
		 * `PHOENIX_DB` (maintained inline by the sozluk/pano writer modules)
		 * plus a cross-product distinct-author union. Always returns a non-null
		 * object even on a cold DB — counts default to 0 so the SPA doesn't have
		 * to special-case the empty state.
		 */
		landingStats: {
			type: new GraphQLNonNull(LandingStatsType),
			resolve: resolver(function* () {
				const env = yield* CloudflareEnv;
				const stats = yield* Effect.promise(() => readLandingStats(env.PHOENIX_DB));
				return {...stats, version: PHOENIX_BUILD_VERSION};
			}),
		},
	},
});

/**
 * Input for the `submitPost` mutation. The `kind` is one of the fixed enum
 * values (`göster` / `tartışma` / `soru` / `söylenme` / `meta`) — validated
 * at the resolver and re-validated inside the Agent for defense-in-depth.
 *
 * `label` is an optional human-presentation override; if omitted the kind
 * value is used (which is already Turkish in this enum).
 */
const TagInputType = new GraphQLInputObjectType({
	name: "TagInput",
	fields: {
		kind: {type: new GraphQLNonNull(GraphQLString)},
		label: {type: GraphQLString},
	},
});

interface TagInput {
	kind: string;
	label?: string | null;
}

// The three `map{Definition,Post,Comment}MutationError` helpers used to live
// here. The Effect `resolver()` wrapper now routes every thrown agent error
// through `encodeMutationError` in `./errors`, so resolvers can throw the raw
// error and the wire-format `extensions.code` is applied in one place.

const MutationType = new GraphQLObjectType({
	name: "Mutation",
	fields: {
		setUsername: {
			type: new GraphQLNonNull(UserType),
			args: {value: {type: new GraphQLNonNull(GraphQLString)}},
			resolve: resolver(function* (_source, args: {value: string}) {
				const {user} = yield* Auth.required;
				const pasaport = yield* Pasaport;
				const result = yield* pasaport.setUsername({userId: user.id, value: args.value});
				return {
					id: result.userId,
					email: user.email,
					name: result.displayName,
					image: result.image,
					username: result.username,
				};
			}),
		},
		addDefinition: {
			type: new GraphQLNonNull(DefinitionType),
			args: {
				termSlug: {type: new GraphQLNonNull(GraphQLString)},
				termTitle: {type: GraphQLString},
				body: {type: new GraphQLNonNull(GraphQLString)},
			},
			resolve: resolver(function* (
				_source,
				args: {termSlug: string; termTitle?: string | null; body: string},
			) {
				const {user} = yield* Auth.required;
				const sozluk = yield* Sozluk;
				// Validation lives inside `sozluk.addDefinition` (ADR 0013) —
				// `BodyRequired` / `BodyTooLong` flow through the resolver
				// wrapper, which routes them through `encodeMutationError` for
				// the wire-format extensions.code.
				const result = yield* sozluk.addDefinition({
					termSlug: args.termSlug,
					authorId: user.id,
					authorName: user.name ?? user.email,
					body: args.body,
					...(args.termTitle ? {termTitle: args.termTitle} : {}),
				});
				return {
					id: result.definitionId,
					body: result.body,
					author: result.authorName,
					authorId: result.authorId,
					score: result.score,
					createdAt: result.createdAt,
					updatedAt: result.updatedAt,
				} satisfies DefinitionRow;
			}),
		},
		voteDefinition: {
			type: new GraphQLNonNull(DefinitionType),
			args: {definitionId: {type: new GraphQLNonNull(GraphQLID)}},
			resolve: resolver(function* (_source, args: {definitionId: string}) {
				const {user} = yield* Auth.required;
				const sozluk = yield* Sozluk;
				// Accept either a Relay global id (post-migration FE) or a raw
				// local id. `extractLocalId` is a no-op for raw ids.
				const definitionId = extractLocalId(args.definitionId, "Definition");
				const result = yield* sozluk.voteDefinition({definitionId, voterId: user.id});
				return {
					id: result.definitionId,
					body: result.body,
					author: result.authorName,
					authorId: result.authorId,
					score: result.score,
					createdAt: result.createdAt,
					updatedAt: result.updatedAt,
					// Stamp myVote authoritatively so the Definition.myVote
					// resolver doesn't have to re-read user_vote.
					myVote: result.myVote,
				} as DefinitionRow & {myVote: number | null};
			}),
		},
		retractDefinitionVote: {
			type: new GraphQLNonNull(DefinitionType),
			args: {definitionId: {type: new GraphQLNonNull(GraphQLID)}},
			resolve: resolver(function* (_source, args: {definitionId: string}) {
				const {user} = yield* Auth.required;
				const sozluk = yield* Sozluk;
				const definitionId = extractLocalId(args.definitionId, "Definition");
				const result = yield* sozluk.retractDefinitionVote({definitionId, voterId: user.id});
				return {
					id: result.definitionId,
					body: result.body,
					author: result.authorName,
					authorId: result.authorId,
					score: result.score,
					createdAt: result.createdAt,
					updatedAt: result.updatedAt,
					myVote: result.myVote,
				} as DefinitionRow & {myVote: number | null};
			}),
		},
		editDefinition: {
			type: new GraphQLNonNull(DefinitionType),
			args: {
				id: {type: new GraphQLNonNull(GraphQLID)},
				body: {type: new GraphQLNonNull(GraphQLString)},
			},
			resolve: resolver(function* (_source, args: {id: string; body: string}) {
				const {user} = yield* Auth.required;
				const sozluk = yield* Sozluk;
				const definitionId = extractLocalId(args.id, "Definition");
				const result = yield* sozluk.editDefinition({
					definitionId,
					actorId: user.id,
					body: args.body,
				});
				return {
					id: result.definitionId,
					body: result.body,
					author: result.authorName,
					authorId: result.authorId,
					score: result.score,
					createdAt: result.createdAt,
					updatedAt: result.updatedAt,
				} satisfies DefinitionRow;
			}),
		},
		/**
		 * Soft-delete a definition. Payload
		 * shape `DeleteDefinitionPayload!` with `deletedDefinitionId: ID!`
		 * so the SPA can `@deleteRecord` it from the Relay store.
		 */
		deleteDefinition: {
			type: new GraphQLNonNull(DeleteDefinitionPayloadType),
			args: {id: {type: new GraphQLNonNull(GraphQLID)}},
			resolve: resolver(function* (_source, args: {id: string}) {
				const {user} = yield* Auth.required;
				const sozluk = yield* Sozluk;
				const definitionId = extractLocalId(args.id, "Definition");
				const result = yield* sozluk.deleteDefinition({definitionId, actorId: user.id});
				return {
					deletedDefinitionId: encodeNodeId("Definition", result.definitionId),
				};
			}),
		},
		submitPost: {
			type: new GraphQLNonNull(PostType),
			args: {
				title: {type: new GraphQLNonNull(GraphQLString)},
				url: {type: GraphQLString},
				body: {type: GraphQLString},
				tags: {
					type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TagInputType))),
				},
			},
			resolve: resolver(function* (
				_source,
				args: {
					title: string;
					url?: string | null;
					body?: string | null;
					tags: TagInput[];
				},
			) {
				const {user} = yield* Auth.required;

				// ----- resolver-side validation (mirrors service for fast-fail UX) -----
				const title = (args.title ?? "").trim();
				if (title.length === 0) {
					throw new GraphQLError("başlık boş olamaz", {
						extensions: {code: "TITLE_REQUIRED"},
					});
				}
				if (title.length > 200) {
					throw new GraphQLError("başlık en fazla 200 karakter olabilir", {
						extensions: {code: "TITLE_TOO_LONG"},
					});
				}
				if (args.body != null && args.body.length > 10_000) {
					throw new GraphQLError("metin en fazla 10000 karakter olabilir", {
						extensions: {code: "BODY_TOO_LONG"},
					});
				}
				if (args.url != null && args.url.length > 0) {
					try {
						new URL(args.url);
					} catch {
						throw new GraphQLError("URL geçersiz", {
							extensions: {code: "URL_INVALID"},
						});
					}
				}
				if (!args.tags || args.tags.length === 0) {
					throw new GraphQLError("en az bir etiket seç", {
						extensions: {code: "TAGS_REQUIRED"},
					});
				}
				const allowed = new Set<string>(ALLOWED_POST_TAG_KINDS);
				for (const t of args.tags) {
					if (!allowed.has(t.kind)) {
						throw new GraphQLError(`geçersiz etiket: ${t.kind}`, {
							extensions: {code: "TAG_INVALID"},
						});
					}
				}

				// Service mints the post id internally and writes PHOENIX_DB
				// inline. PostValidation falls through to the resolver wrapper.
				const pano = yield* Pano;
				const r = yield* pano.submitPost({
					title: args.title,
					...(args.url ? {url: args.url} : {}),
					...(args.body ? {body: args.body} : {}),
					tags: args.tags.map((t) => ({
						kind: t.kind,
						...(t.label ? {label: t.label} : {}),
					})),
					authorId: user.id,
					authorName: user.name ?? user.email,
				});
				return {
					id: r.postId,
					slug: null,
					title: r.title,
					url: r.url,
					host: r.host,
					body: r.body,
					author: r.authorName,
					authorId: r.authorId,
					score: r.score,
					commentCount: r.commentCount,
					createdAt: r.createdAt,
					// SubmitPostResult is a fresh write; updatedAt === createdAt
					// by definition. Mirrors the per-DO `getPost` shape (T17).
					updatedAt: r.createdAt,
					tags: r.tags,
				} satisfies PostPage;
			}),
		},
		voteOnPost: {
			type: new GraphQLNonNull(PostType),
			args: {postId: {type: new GraphQLNonNull(GraphQLID)}},
			resolve: resolver(function* (_source, args: {postId: string}) {
				const {user} = yield* Auth.required;
				const postId = extractLocalId(args.postId, "Post");
				// Service writes PHOENIX_DB via Drizzle.batch. PostNotFound
				// falls through to the resolver wrapper, which encodes the
				// wire-format extensions.code via `encodeMutationError`.
				const pano = yield* Pano;
				const result = yield* pano.voteOnPost({postId, voterId: user.id});
				return {
					id: result.postId,
					slug: null,
					title: result.title,
					url: result.url,
					host: result.host,
					body: result.body,
					author: result.authorName,
					authorId: result.authorId,
					score: result.score,
					commentCount: result.commentCount,
					createdAt: result.createdAt,
					// Vote results don't reshape body/title; pin updatedAt
					// to createdAt — the next read will refresh
					// the actual updatedAt and the "düzenlendi" indicator.
					updatedAt: result.createdAt,
					tags: result.tags,
					// Stamp myVote authoritatively so the Post.myVote resolver
					// doesn't have to re-read user_vote.
					myVote: result.myVote,
				} as PostPage & {myVote: number | null};
			}),
		},
		retractPostVote: {
			type: new GraphQLNonNull(PostType),
			args: {postId: {type: new GraphQLNonNull(GraphQLID)}},
			resolve: resolver(function* (_source, args: {postId: string}) {
				const {user} = yield* Auth.required;
				const postId = extractLocalId(args.postId, "Post");
				const pano = yield* Pano;
				const result = yield* pano.retractPostVote({postId, voterId: user.id});
				return {
					id: result.postId,
					slug: null,
					title: result.title,
					url: result.url,
					host: result.host,
					body: result.body,
					author: result.authorName,
					authorId: result.authorId,
					score: result.score,
					commentCount: result.commentCount,
					createdAt: result.createdAt,
					updatedAt: result.createdAt,
					tags: result.tags,
					myVote: result.myVote,
				} as PostPage & {myVote: number | null};
			}),
		},
		editPost: {
			type: new GraphQLNonNull(PostType),
			args: {
				id: {type: new GraphQLNonNull(GraphQLID)},
				title: {type: GraphQLString},
				body: {type: GraphQLString},
			},
			resolve: resolver(function* (
				_source,
				args: {id: string; title?: string | null; body?: string | null},
			) {
				const {user} = yield* Auth.required;

				// At least one of title/body must be provided. The service
				// re-checks (defense-in-depth) but a resolver-side check yields
				// a faster failure with a typed code.
				if (args.title == null && args.body == null) {
					throw new GraphQLError("başlık veya metin gerekli", {
						extensions: {code: "TITLE_REQUIRED"},
					});
				}

				const postId = extractLocalId(args.id, "Post");
				const pano = yield* Pano;
				const r = yield* pano.editPost({
					postId,
					actorId: user.id,
					...(args.title != null ? {title: args.title} : {}),
					...(args.body != null ? {body: args.body} : {}),
				});
				return {
					id: r.postId,
					slug: null,
					title: r.title,
					url: r.url,
					host: r.host,
					body: r.body,
					author: r.authorName,
					authorId: r.authorId,
					score: r.score,
					commentCount: r.commentCount,
					createdAt: r.createdAt,
					// EditPostResult carries updatedAt; mirror it onto the
					// `Post` shape so the "düzenlendi" indicator picks it up
					// immediately after a successful edit (T17).
					updatedAt: r.updatedAt,
					tags: r.tags,
				} satisfies PostPage;
			}),
		},
		/**
		 * Delete a post. Returns the global id
		 * of the deleted post; the FE attaches `@deleteRecord` to that field
		 * so Relay removes the record from its store, which in turn auto-clears
		 * every edge in every `PanoFeed_posts` connection variant that
		 * references it. No `$connections` plumbing required.
		 */
		deletePost: {
			type: new GraphQLNonNull(GraphQLID),
			args: {id: {type: new GraphQLNonNull(GraphQLID)}},
			resolve: resolver(function* (_source, args: {id: string}) {
				const {user} = yield* Auth.required;
				const postId = extractLocalId(args.id, "Post");
				const pano = yield* Pano;
				const r = yield* pano.deletePost({postId, actorId: user.id});
				// Return the Relay global id so `@deleteRecord` can find the
				// store record under the same DataID Relay normalized the
				// `Post` to (`encodeNodeId("Post", localId)`).
				return encodeNodeId("Post", r.postId);
			}),
		},
		addComment: {
			type: new GraphQLNonNull(CommentType),
			args: {
				postId: {type: new GraphQLNonNull(GraphQLID)},
				parentId: {type: GraphQLID},
				body: {type: new GraphQLNonNull(GraphQLString)},
			},
			resolve: resolver(function* (
				_source,
				args: {postId: string; parentId?: string | null; body: string},
			) {
				const {user} = yield* Auth.required;

				const postId = extractLocalId(args.postId, "Post");
				const parentId = args.parentId ? extractLocalId(args.parentId, "Comment") : null;
				const pano = yield* Pano;
				const result = yield* pano.addComment({
					postId,
					authorId: user.id,
					authorName: user.name ?? user.email,
					body: args.body,
					...(parentId ? {parentId} : {}),
				});
				return {
					id: result.commentId,
					parentId: result.parentId,
					author: result.authorName,
					authorId: result.authorId,
					body: result.body,
					score: result.score,
					createdAt: result.createdAt,
					// Fresh write: updatedAt === createdAt by definition.
					updatedAt: result.createdAt,
				} satisfies CommentRow;
			}),
		},
		voteOnComment: {
			type: new GraphQLNonNull(CommentType),
			args: {commentId: {type: new GraphQLNonNull(GraphQLID)}},
			resolve: resolver(function* (_source, args: {commentId: string}) {
				const {user} = yield* Auth.required;
				const commentId = extractLocalId(args.commentId, "Comment");
				const pano = yield* Pano;
				const result = yield* pano.voteOnComment({commentId, voterId: user.id});
				return {
					id: result.commentId,
					parentId: result.parentId,
					author: result.authorName,
					authorId: result.authorId,
					body: result.body,
					score: result.score,
					createdAt: result.createdAt,
					updatedAt: result.createdAt,
					// Stamp myVote authoritatively so the Comment.myVote
					// resolver doesn't race against a stale read.
					myVote: result.myVote,
				} as CommentRow & {myVote: number | null};
			}),
		},
		retractCommentVote: {
			type: new GraphQLNonNull(CommentType),
			args: {commentId: {type: new GraphQLNonNull(GraphQLID)}},
			resolve: resolver(function* (_source, args: {commentId: string}) {
				const {user} = yield* Auth.required;
				const commentId = extractLocalId(args.commentId, "Comment");
				const pano = yield* Pano;
				const result = yield* pano.retractCommentVote({commentId, voterId: user.id});
				return {
					id: result.commentId,
					parentId: result.parentId,
					author: result.authorName,
					authorId: result.authorId,
					body: result.body,
					score: result.score,
					createdAt: result.createdAt,
					updatedAt: result.createdAt,
					myVote: result.myVote,
				} as CommentRow & {myVote: number | null};
			}),
		},
		/**
		 * Edit a comment's body. `Auth.required` enforces sign-in; ownership
		 * is enforced inside the D1-direct module. Errors flow through the
		 * `resolver()` wrapper's encodeMutationError catch path.
		 */
		editComment: {
			type: new GraphQLNonNull(CommentType),
			args: {
				id: {type: new GraphQLNonNull(GraphQLID)},
				body: {type: new GraphQLNonNull(GraphQLString)},
			},
			resolve: resolver(function* (_source, args: {id: string; body: string}) {
				const {user} = yield* Auth.required;
				const commentId = extractLocalId(args.id, "Comment");
				const pano = yield* Pano;
				const r = yield* pano.editComment({commentId, actorId: user.id, body: args.body});
				return {
					id: r.commentId,
					parentId: r.parentId,
					author: r.authorName,
					authorId: r.authorId,
					body: r.body,
					score: r.score,
					createdAt: r.createdAt,
					updatedAt: r.updatedAt,
				} satisfies CommentRow;
			}),
		},
		/**
		 * Soft-delete a comment. Reply-aware: the leaf path returns
		 * `deletedCommentId` so the FE can `@deleteRecord` the row out of
		 * the Relay store; the parent-with-replies path returns the same
		 * `Comment` with `body = '[silindi]'` and `deletedAt` set so Relay's
		 * automatic store update handles the placeholder rerender. Exactly
		 * one of the two payload fields is non-null per call.
		 *
		 * `Auth.required` + ownership inside the D1-direct module.
		 */
		deleteComment: {
			type: new GraphQLNonNull(DeleteCommentPayloadType),
			args: {id: {type: new GraphQLNonNull(GraphQLID)}},
			resolve: resolver(function* (_source, args: {id: string}) {
				const {user} = yield* Auth.required;
				const commentId = extractLocalId(args.id, "Comment");
				const pano = yield* Pano;
				const r = yield* pano.deleteComment({commentId, actorId: user.id});
				if (r.hasReplies && r.placeholder) {
					// Parent-with-replies: surface the `[silindi]` placeholder row
					// so Relay merges the new scalar values into the existing
					// `Comment:<global-id>` DataID and rerenders in place.
					return {deletedCommentId: null, comment: r.placeholder};
				}
				// Leaf (or idempotent no-op): hand the FE the global id so
				// `@deleteRecord` removes the record from the store.
				return {
					deletedCommentId: encodeNodeId("Comment", r.commentId),
					comment: null,
				};
			}),
		},
	},
});

export const schema = new GraphQLSchema({query: QueryType, mutation: MutationType});

/**
 * Stable, sorted SDL printout — used by relay-compiler in apps/web
 * to generate __generated__ artifacts.
 */
export const printSchemaSDL = (): string => printSchema(lexicographicSortSchema(schema));
