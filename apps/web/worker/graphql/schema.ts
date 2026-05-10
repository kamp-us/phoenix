import {id} from "@usirin/forge";
import {Effect} from "effect";
import {
	GraphQLBoolean,
	GraphQLEnumType,
	GraphQLError,
	GraphQLID,
	GraphQLInputObjectType,
	GraphQLInt,
	GraphQLList,
	GraphQLNonNull,
	GraphQLObjectType,
	GraphQLSchema,
	GraphQLString,
	GraphQLUnionType,
	lexicographicSortSchema,
	printSchema,
} from "graphql";
import {lookupCommentPostId} from "../features/pano/commentViewReader";
import {
	ALLOWED_POST_TAG_KINDS,
	CommentNotFoundError,
	type CommentRow,
	CommentValidationError,
	PostNotFoundError,
	type PostPage,
	type PostTagRow,
	PostValidationError,
} from "../features/pano/PanoPost";
import {
	listPostSummaries,
	type PostSort,
	type PostSummaryRow,
} from "../features/pano/postSummaryReader";
import {UsernameValidationError} from "../features/pasaport/Pasaport";
import {
	type ContributionConnection,
	type ContributionNode,
	listContributions,
	lookupProfile,
	type ProfileRow,
} from "../features/pasaport/userProfileReader";
import type {DefinitionRow, ListSort, TermPage, TermSummary} from "../features/sozluk/Sozluk";
import {
	DefinitionNotFoundError,
	DefinitionValidationError,
	UnauthorizedDefinitionMutationError,
} from "../features/sozluk/SozlukTerm";
import {listTermSummaries, type TermSummaryRow} from "../features/sozluk/termSummaryReader";
import {lookupDefinitionTermSlug, readMyVote} from "../features/sozluk/userVoteReader";
import {Auth, CloudflareEnv} from "../services";
import {type LandingStats, readLandingStats} from "../view/landingStatsReader";
import {resolver} from "./resolver";

const HealthType = new GraphQLObjectType({
	name: "Health",
	fields: {
		status: {type: new GraphQLNonNull(GraphQLString)},
		environment: {type: new GraphQLNonNull(GraphQLString)},
	},
});

const UserType = new GraphQLObjectType({
	name: "User",
	fields: {
		id: {type: new GraphQLNonNull(GraphQLID)},
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
	fields: {
		id: {type: new GraphQLNonNull(GraphQLID)},
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
				const env = yield* CloudflareEnv;
				return yield* Effect.promise(() =>
					readMyVote(env.PHOENIX_DB, {
						userId: auth.user!.id,
						targetKind: "definition",
						targetId: parent.id,
					}),
				);
			}),
		},
	},
});

/**
 * Single Term type backs both list (TermSummary) and detail (TermPage)
 * queries. Fields specific to one shape (excerpt, definitions, firstAt,
 * lastEdit) resolve to null / empty when the source doesn't carry them —
 * matches GraphQL execution: clients only request what they need.
 */
const TermType: GraphQLObjectType = new GraphQLObjectType<TermSummary | TermPage | TermSummaryRow>({
	name: "Term",
	fields: () => ({
		id: {type: new GraphQLNonNull(GraphQLID)},
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
		definitions: {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(DefinitionType))),
			resolve: (s) => ("definitions" in s ? s.definitions : []),
		},
	}),
});

const TermSortEnum = new GraphQLEnumType({
	name: "TermSort",
	values: {
		recent: {value: "recent"},
		popular: {value: "popular"},
	},
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
	fields: () => ({
		id: {type: new GraphQLNonNull(GraphQLID)},
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
				const env = yield* CloudflareEnv;
				return yield* Effect.promise(() =>
					readMyVote(env.PHOENIX_DB, {
						userId: auth.user!.id,
						targetKind: "post",
						targetId: parent.id,
					}),
				);
			}),
		},
	}),
});

const CommentType = new GraphQLObjectType<CommentRow>({
	name: "Comment",
	fields: {
		id: {type: new GraphQLNonNull(GraphQLID)},
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
				const env = yield* CloudflareEnv;
				return yield* Effect.promise(() =>
					readMyVote(env.PHOENIX_DB, {
						userId: auth.user!.id,
						targetKind: "comment",
						targetId: parent.id,
					}),
				);
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

const PageInfoType = new GraphQLObjectType<{hasNextPage: boolean; endCursor: string | null}>({
	name: "PageInfo",
	fields: {
		hasNextPage: {type: new GraphQLNonNull(GraphQLBoolean)},
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
	},
});

const ProfileType = new GraphQLObjectType<ProfileRow>({
	name: "Profile",
	fields: {
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
				const env = yield* CloudflareEnv;
				return yield* Effect.promise(() =>
					listContributions(env.PHOENIX_DB, {
						authorId: parent.userId,
						after: args.after ?? null,
						first: args.first ?? 20,
					}),
				);
			}),
		},
	},
});

/* -------------------------------------------------------------------------- */
/* Landing stats (T15)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Single object backing the landing-page stats card. Sourced from the
 * `sozluk_stats` + `pano_stats` MV rows (maintained by the `PhoenixProjection`
 * workflow) plus a cross-product distinct-author union. `version` is the build
 * tag the SPA renders alongside the counts — currently hardcoded; T18's
 * wrangler config / cf-typegen pass can swap it for a build-time env var.
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
				const env = yield* CloudflareEnv;
				const stub = env.PASAPORT.get(env.PASAPORT.idFromName("kampus"));
				const fresh = yield* Effect.promise(() => stub.getUserById(auth.user!.id));
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
		terms: {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TermType))),
			args: {
				sort: {type: TermSortEnum},
				limit: {type: GraphQLInt},
			},
			resolve: resolver(function* (_source, args: {sort?: ListSort; limit?: number}) {
				const env = yield* CloudflareEnv;
				return yield* Effect.promise(() =>
					listTermSummaries(env.PHOENIX_DB, {
						...(args.sort ? {sort: args.sort} : {}),
						...(args.limit != null ? {limit: args.limit} : {}),
					}),
				);
			}),
		},
		term: {
			type: TermType,
			args: {slug: {type: new GraphQLNonNull(GraphQLString)}},
			resolve: resolver(function* (_source, args: {slug: string}) {
				const env = yield* CloudflareEnv;
				const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(args.slug));
				return yield* Effect.promise(() => stub.getTerm());
			}),
		},
		posts: {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PostType))),
			args: {
				sort: {type: PostSortEnum},
				limit: {type: GraphQLInt},
				host: {type: GraphQLString},
			},
			resolve: resolver(function* (
				_source,
				args: {sort?: PostSort; limit?: number; host?: string},
			) {
				const env = yield* CloudflareEnv;
				return yield* Effect.promise(() =>
					listPostSummaries(env.PHOENIX_DB, {
						...(args.sort ? {sort: args.sort} : {}),
						...(args.limit != null ? {limit: args.limit} : {}),
						...(args.host ? {host: args.host} : {}),
					}),
				);
			}),
		},
		post: {
			type: PostType,
			args: {idOrSlug: {type: new GraphQLNonNull(GraphQLString)}},
			resolve: resolver(function* (_source, args: {idOrSlug: string}) {
				const env = yield* CloudflareEnv;
				const stub = env.PANO_POST.get(env.PANO_POST.idFromName(args.idOrSlug));
				return yield* Effect.promise(() => stub.getPost());
			}),
		},
		postComments: {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(CommentType))),
			args: {postId: {type: new GraphQLNonNull(GraphQLString)}},
			resolve: resolver(function* (_source, args: {postId: string}) {
				const env = yield* CloudflareEnv;
				const stub = env.PANO_POST.get(env.PANO_POST.idFromName(args.postId));
				return yield* Effect.promise(() => stub.listComments());
			}),
		},
		/**
		 * Public profile by username (T14). Returns `null` for an unknown
		 * username — the SPA renders the 404 page in that case. Aggregates
		 * (`totalKarma`, `*Count`) read from the `user_profile` MV (karma)
		 * and the per-kind view tables (counts derived live, see
		 * `userProfileReader.lookupProfile`). The `contributions` field
		 * resolves the interleaved feed; pagination is keyset on
		 * `(created_at DESC, id DESC)` via a composite ULID cursor.
		 */
		profile: {
			type: ProfileType,
			args: {username: {type: new GraphQLNonNull(GraphQLString)}},
			resolve: resolver(function* (_source, args: {username: string}) {
				const env = yield* CloudflareEnv;
				return yield* Effect.promise(() => lookupProfile(env.PHOENIX_DB, args.username));
			}),
		},
		/**
		 * Landing-page stats card (T15). Reads the single-row aggregates
		 * maintained by the `PhoenixProjection` workflow plus a cross-product
		 * distinct-author union. Always returns a non-null object even on a
		 * cold DB — counts default to 0 so the SPA doesn't have to special-case
		 * the empty state.
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

/**
 * Map an Agent-thrown definition mutation error onto the SPA-facing GraphQL
 * error shape with a stable `code` extension. Errors come back across the
 * RPC boundary as plain Error objects (the class identity is lost in
 * marshaling) — name + message preserve.
 */
function mapDefinitionMutationError(err: unknown): GraphQLError {
	const e = err as Error & {code?: string};
	if (e?.name === "UnauthorizedDefinitionMutationError") {
		return new GraphQLError("not authorized", {extensions: {code: "UNAUTHORIZED"}});
	}
	if (e?.name === "DefinitionNotFoundError") {
		return new GraphQLError(e.message ?? "definition not found", {
			extensions: {code: "DEFINITION_NOT_FOUND"},
		});
	}
	if (e?.name === "DefinitionValidationError") {
		const code = e.code ? e.code.toUpperCase() : "BAD_REQUEST";
		return new GraphQLError(e.message ?? "definition validation failed", {
			extensions: {code},
		});
	}
	// Unknown — surface as a generic GraphQL error so the SPA can render it
	// instead of seeing Yoga's "Unexpected error" mask.
	return new GraphQLError(e?.message ?? "definition mutation failed", {
		extensions: {code: "INTERNAL_SERVER_ERROR"},
	});
}

/**
 * Map an Agent-thrown post mutation error onto a GraphQL error. Agent errors
 * cross the RPC boundary as plain `Error` (class identity is lost), so we
 * match on `name` + `code` and bake a stable `code` extension into the
 * GraphQL error so the SPA can localize without parsing free-text messages.
 */
function mapPostMutationError(err: unknown): GraphQLError {
	const e = err as Error & {code?: string};
	if (e?.name === "UnauthorizedPostMutationError") {
		return new GraphQLError("not authorized", {extensions: {code: "UNAUTHORIZED"}});
	}
	if (e?.name === "PostNotFoundError") {
		return new GraphQLError(e.message ?? "post not found", {
			extensions: {code: "POST_NOT_FOUND"},
		});
	}
	if (e?.name === "PostValidationError") {
		const code = e.code ? e.code.toUpperCase() : "BAD_REQUEST";
		return new GraphQLError(e.message ?? "post validation failed", {
			extensions: {code},
		});
	}
	return new GraphQLError(e?.message ?? "post mutation failed", {
		extensions: {code: "INTERNAL_SERVER_ERROR"},
	});
}

/**
 * Map an Agent-thrown comment mutation error onto a GraphQL error. Agent
 * errors cross the RPC boundary as plain `Error` (class identity is lost),
 * so we match on `name` + `code` and bake a stable `code` extension into the
 * GraphQL error so the SPA can localize without parsing free-text messages.
 * Mirrors `mapPostMutationError` (T9) and `mapDefinitionMutationError` (T6).
 */
function mapCommentMutationError(err: unknown): GraphQLError {
	const e = err as Error & {code?: string};
	if (e?.name === "UnauthorizedCommentMutationError") {
		return new GraphQLError("not authorized", {extensions: {code: "UNAUTHORIZED"}});
	}
	if (e?.name === "CommentNotFoundError") {
		return new GraphQLError(e.message ?? "comment not found", {
			extensions: {code: "COMMENT_NOT_FOUND"},
		});
	}
	if (e?.name === "PostNotFoundError") {
		return new GraphQLError(e.message ?? "post not found", {
			extensions: {code: "POST_NOT_FOUND"},
		});
	}
	if (e?.name === "CommentValidationError") {
		const code = e.code ? e.code.toUpperCase() : "BAD_REQUEST";
		return new GraphQLError(e.message ?? "comment validation failed", {
			extensions: {code},
		});
	}
	return new GraphQLError(e?.message ?? "comment mutation failed", {
		extensions: {code: "INTERNAL_SERVER_ERROR"},
	});
}

const MutationType = new GraphQLObjectType({
	name: "Mutation",
	fields: {
		setUsername: {
			type: new GraphQLNonNull(UserType),
			args: {value: {type: new GraphQLNonNull(GraphQLString)}},
			resolve: resolver(function* (_source, args: {value: string}) {
				const {user} = yield* Auth.required;
				const env = yield* CloudflareEnv;
				const stub = env.PASAPORT.get(env.PASAPORT.idFromName("kampus"));
				try {
					const result = yield* Effect.promise(() =>
						stub.setUsername({userId: user.id, value: args.value}),
					);
					return {
						id: result.userId,
						email: user.email,
						name: result.displayName,
						image: result.image,
						username: result.username,
					};
				} catch (err) {
					if (err instanceof UsernameValidationError) {
						throw new GraphQLError(err.message, {
							extensions: {code: err.code.toUpperCase()},
						});
					}
					throw err;
				}
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
				const env = yield* CloudflareEnv;
				const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(args.termSlug));
				try {
					const result = yield* Effect.promise(() =>
						stub.addDefinition({
							authorId: user.id,
							authorName: user.name ?? user.email,
							body: args.body,
							...(args.termTitle ? {termTitle: args.termTitle} : {}),
						}),
					);
					return {
						id: result.definitionId,
						body: result.body,
						author: result.authorName,
						authorId: result.authorId,
						score: result.score,
						createdAt: result.createdAt,
						updatedAt: result.updatedAt,
					} satisfies DefinitionRow;
				} catch (err) {
					if (err instanceof DefinitionValidationError) {
						throw new GraphQLError(err.message, {
							extensions: {code: err.code.toUpperCase()},
						});
					}
					throw err;
				}
			}),
		},
		voteDefinition: {
			type: new GraphQLNonNull(DefinitionType),
			args: {definitionId: {type: new GraphQLNonNull(GraphQLID)}},
			resolve: resolver(function* (_source, args: {definitionId: string}) {
				const {user} = yield* Auth.required;
				const env = yield* CloudflareEnv;
				// The definition's term is encoded by the DO instance the resolver
				// targets. The frontend always knows the term slug from the page
				// URL (vote button lives on a term page) — but the GraphQL surface
				// only takes the definition id. The producer-side projection's
				// `definition_view` row carries `term_slug` so we lean on it for
				// the dispatch.
				const slug = yield* Effect.promise(() =>
					lookupDefinitionTermSlug(env.PHOENIX_DB, args.definitionId),
				);
				if (!slug) {
					throw new GraphQLError("definition not found", {
						extensions: {code: "DEFINITION_NOT_FOUND"},
					});
				}
				const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(slug));
				try {
					const result = yield* Effect.promise(() =>
						stub.voteDefinition({definitionId: args.definitionId, voterId: user.id}),
					);
					return {
						id: result.definitionId,
						body: result.body,
						author: result.authorName,
						authorId: result.authorId,
						score: result.score,
						createdAt: result.createdAt,
						updatedAt: result.updatedAt,
						// Stamp myVote authoritatively so the Definition.myVote
						// resolver doesn't race against the user_vote projection.
						myVote: result.myVote,
					} as DefinitionRow & {myVote: number | null};
				} catch (err) {
					if (err instanceof DefinitionNotFoundError) {
						throw new GraphQLError(err.message, {
							extensions: {code: "DEFINITION_NOT_FOUND"},
						});
					}
					throw err;
				}
			}),
		},
		retractDefinitionVote: {
			type: new GraphQLNonNull(DefinitionType),
			args: {definitionId: {type: new GraphQLNonNull(GraphQLID)}},
			resolve: resolver(function* (_source, args: {definitionId: string}) {
				const {user} = yield* Auth.required;
				const env = yield* CloudflareEnv;
				const slug = yield* Effect.promise(() =>
					lookupDefinitionTermSlug(env.PHOENIX_DB, args.definitionId),
				);
				if (!slug) {
					throw new GraphQLError("definition not found", {
						extensions: {code: "DEFINITION_NOT_FOUND"},
					});
				}
				const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(slug));
				try {
					const result = yield* Effect.promise(() =>
						stub.retractDefinitionVote({definitionId: args.definitionId, voterId: user.id}),
					);
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
				} catch (err) {
					if (err instanceof DefinitionNotFoundError) {
						throw new GraphQLError(err.message, {
							extensions: {code: "DEFINITION_NOT_FOUND"},
						});
					}
					throw err;
				}
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
				const env = yield* CloudflareEnv;
				const slug = yield* Effect.promise(() => lookupDefinitionTermSlug(env.PHOENIX_DB, args.id));
				if (!slug) {
					throw new GraphQLError("definition not found", {
						extensions: {code: "DEFINITION_NOT_FOUND"},
					});
				}
				const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(slug));
				// Run the RPC as a plain Promise we can `try/catch` against — keeps
				// the agent-thrown error classes catchable on the Yoga request path.
				try {
					const result = yield* Effect.promise(() =>
						stub
							.editDefinition({
								definitionId: args.id,
								actorId: user.id,
								body: args.body,
							})
							.then(
								(value) => ({ok: true as const, value}),
								(error: unknown) => ({ok: false as const, error}),
							),
					);
					if (!result.ok) {
						throw mapDefinitionMutationError(result.error);
					}
					const r = result.value;
					return {
						id: r.definitionId,
						body: r.body,
						author: r.authorName,
						authorId: r.authorId,
						score: r.score,
						createdAt: r.createdAt,
						updatedAt: r.updatedAt,
					} satisfies DefinitionRow;
				} catch (err) {
					if (err instanceof GraphQLError) throw err;
					throw err;
				}
			}),
		},
		deleteDefinition: {
			type: new GraphQLNonNull(GraphQLString),
			args: {id: {type: new GraphQLNonNull(GraphQLID)}},
			resolve: resolver(function* (_source, args: {id: string}) {
				const {user} = yield* Auth.required;
				const env = yield* CloudflareEnv;
				const slug = yield* Effect.promise(() => lookupDefinitionTermSlug(env.PHOENIX_DB, args.id));
				if (!slug) {
					throw new GraphQLError("definition not found", {
						extensions: {code: "DEFINITION_NOT_FOUND"},
					});
				}
				const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(slug));
				const result = yield* Effect.promise(() =>
					stub.deleteDefinition({definitionId: args.id, actorId: user.id}).then(
						(value) => ({ok: true as const, value}),
						(error: unknown) => ({ok: false as const, error}),
					),
				);
				if (!result.ok) {
					throw mapDefinitionMutationError(result.error);
				}
				// SDL is `deleteDefinition: String!` — return the id as a stable
				// success token so the SPA can confirm + invalidate caches.
				return result.value.definitionId;
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
				const env = yield* CloudflareEnv;

				// ----- resolver-side validation (mirrors Agent for fast-fail UX) -----
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

				// ----- mint a fresh post id; route to the new DO ------------------
				const postId = id("post");
				const stub = env.PANO_POST.get(env.PANO_POST.idFromName(postId));

				const result = yield* Effect.promise(() =>
					stub
						.submitPost({
							title: args.title,
							...(args.url ? {url: args.url} : {}),
							...(args.body ? {body: args.body} : {}),
							tags: args.tags.map((t) => ({
								kind: t.kind,
								...(t.label ? {label: t.label} : {}),
							})),
							authorId: user.id,
							authorName: user.name ?? user.email,
						})
						.then(
							(value) => ({ok: true as const, value}),
							(error: unknown) => ({ok: false as const, error}),
						),
				);
				if (!result.ok) {
					if (result.error instanceof PostValidationError) {
						throw mapPostMutationError(result.error);
					}
					throw mapPostMutationError(result.error);
				}
				const r = result.value;
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
				const env = yield* CloudflareEnv;
				const stub = env.PANO_POST.get(env.PANO_POST.idFromName(args.postId));
				try {
					const result = yield* Effect.promise(() => stub.voteOnPost({voterId: user.id}));
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
						// to createdAt — the next `getPost` read will refresh
						// the actual updatedAt and the "düzenlendi" indicator.
						updatedAt: result.createdAt,
						tags: result.tags,
						// Stamp myVote authoritatively so the Post.myVote resolver
						// doesn't race against the user_vote projection landing.
						myVote: result.myVote,
					} as PostPage & {myVote: number | null};
				} catch (err) {
					if (err instanceof PostNotFoundError) {
						throw new GraphQLError(err.message, {
							extensions: {code: "POST_NOT_FOUND"},
						});
					}
					throw err;
				}
			}),
		},
		retractPostVote: {
			type: new GraphQLNonNull(PostType),
			args: {postId: {type: new GraphQLNonNull(GraphQLID)}},
			resolve: resolver(function* (_source, args: {postId: string}) {
				const {user} = yield* Auth.required;
				const env = yield* CloudflareEnv;
				const stub = env.PANO_POST.get(env.PANO_POST.idFromName(args.postId));
				try {
					const result = yield* Effect.promise(() => stub.retractPostVote({voterId: user.id}));
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
						tags: result.tags,
						myVote: result.myVote,
					} as PostPage & {myVote: number | null};
				} catch (err) {
					if (err instanceof PostNotFoundError) {
						throw new GraphQLError(err.message, {
							extensions: {code: "POST_NOT_FOUND"},
						});
					}
					throw err;
				}
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
				const env = yield* CloudflareEnv;

				// At least one of title/body must be provided. The Agent re-checks
				// (defense-in-depth) but a resolver-side check yields a faster
				// failure with a typed code.
				if (args.title == null && args.body == null) {
					throw new GraphQLError("başlık veya metin gerekli", {
						extensions: {code: "TITLE_REQUIRED"},
					});
				}

				const stub = env.PANO_POST.get(env.PANO_POST.idFromName(args.id));
				const result = yield* Effect.promise(() =>
					stub
						.editPost({
							actorId: user.id,
							...(args.title != null ? {title: args.title} : {}),
							...(args.body != null ? {body: args.body} : {}),
						})
						.then(
							(value) => ({ok: true as const, value}),
							(error: unknown) => ({ok: false as const, error}),
						),
				);
				if (!result.ok) {
					throw mapPostMutationError(result.error);
				}
				const r = result.value;
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
		deletePost: {
			type: new GraphQLNonNull(GraphQLString),
			args: {id: {type: new GraphQLNonNull(GraphQLID)}},
			resolve: resolver(function* (_source, args: {id: string}) {
				const {user} = yield* Auth.required;
				const env = yield* CloudflareEnv;
				const stub = env.PANO_POST.get(env.PANO_POST.idFromName(args.id));
				const result = yield* Effect.promise(() =>
					stub.deletePost({actorId: user.id}).then(
						(value) => ({ok: true as const, value}),
						(error: unknown) => ({ok: false as const, error}),
					),
				);
				if (!result.ok) {
					throw mapPostMutationError(result.error);
				}
				// SDL is `deletePost: String!` — return the deleted id so the SPA
				// can confirm + invalidate caches. Mirrors `deleteDefinition` (T6).
				return result.value.postId;
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
				const env = yield* CloudflareEnv;

				// Resolver-side validation for fast-fail UX; the Agent re-validates
				// inside `transactionSync` (defense-in-depth / durability boundary).
				const trimmed = (args.body ?? "").trim();
				if (trimmed.length === 0) {
					throw new GraphQLError("yorum boş olamaz", {
						extensions: {code: "BODY_REQUIRED"},
					});
				}
				if (args.body.length > 5_000) {
					throw new GraphQLError("yorum en fazla 5000 karakter olabilir", {
						extensions: {code: "BODY_TOO_LONG"},
					});
				}

				const stub = env.PANO_POST.get(env.PANO_POST.idFromName(args.postId));
				try {
					const result = yield* Effect.promise(() =>
						stub.addComment({
							authorId: user.id,
							authorName: user.name ?? user.email,
							body: args.body,
							...(args.parentId ? {parentId: args.parentId} : {}),
						}),
					);
					return {
						id: result.commentId,
						parentId: result.parentId,
						author: result.authorName,
						authorId: result.authorId,
						body: result.body,
						score: result.score,
						createdAt: result.createdAt,
						// AddCommentResult is a fresh write; updatedAt === createdAt
						// by definition. Mirrors the per-DO `listComments` shape (T17).
						updatedAt: result.createdAt,
					} satisfies CommentRow;
				} catch (err) {
					if (err instanceof CommentValidationError) {
						throw new GraphQLError(err.message, {
							extensions: {code: err.code.toUpperCase()},
						});
					}
					if (err instanceof PostNotFoundError) {
						throw new GraphQLError(err.message, {
							extensions: {code: "POST_NOT_FOUND"},
						});
					}
					throw err;
				}
			}),
		},
		voteOnComment: {
			type: new GraphQLNonNull(CommentType),
			args: {commentId: {type: new GraphQLNonNull(GraphQLID)}},
			resolve: resolver(function* (_source, args: {commentId: string}) {
				const {user} = yield* Auth.required;
				const env = yield* CloudflareEnv;
				// The comment lives inside its containing post's DO. The frontend
				// always knows the post id from the page URL (vote button lives on
				// a post page) but the GraphQL surface only takes the comment id,
				// so we lean on the projection's denormalized `comment_view.post_id`
				// to route the RPC. Mirrors the `lookupDefinitionTermSlug` pattern
				// from T5's `voteDefinition`.
				const postId = yield* Effect.promise(() =>
					lookupCommentPostId(env.PHOENIX_DB, args.commentId),
				);
				if (!postId) {
					throw new GraphQLError("comment not found", {
						extensions: {code: "COMMENT_NOT_FOUND"},
					});
				}
				const stub = env.PANO_POST.get(env.PANO_POST.idFromName(postId));
				try {
					const result = yield* Effect.promise(() =>
						stub.voteOnComment({
							commentId: args.commentId,
							voterId: user.id,
						}),
					);
					return {
						id: result.commentId,
						parentId: result.parentId,
						author: result.authorName,
						authorId: result.authorId,
						body: result.body,
						score: result.score,
						createdAt: result.createdAt,
						// Vote doesn't change body; the SPA's next read of the
						// comment row will refresh the canonical updatedAt and
						// the "düzenlendi" indicator. Mirrors the post vote
						// resolver (T17).
						updatedAt: result.createdAt,
						// Stamp myVote authoritatively so the Comment.myVote
						// resolver doesn't race against the user_vote projection
						// landing. Same parent-stamping pattern as T5/T8.
						myVote: result.myVote,
					} as CommentRow & {myVote: number | null};
				} catch (err) {
					if (err instanceof CommentNotFoundError) {
						throw new GraphQLError(err.message, {
							extensions: {code: "COMMENT_NOT_FOUND"},
						});
					}
					throw err;
				}
			}),
		},
		retractCommentVote: {
			type: new GraphQLNonNull(CommentType),
			args: {commentId: {type: new GraphQLNonNull(GraphQLID)}},
			resolve: resolver(function* (_source, args: {commentId: string}) {
				const {user} = yield* Auth.required;
				const env = yield* CloudflareEnv;
				const postId = yield* Effect.promise(() =>
					lookupCommentPostId(env.PHOENIX_DB, args.commentId),
				);
				if (!postId) {
					throw new GraphQLError("comment not found", {
						extensions: {code: "COMMENT_NOT_FOUND"},
					});
				}
				const stub = env.PANO_POST.get(env.PANO_POST.idFromName(postId));
				try {
					const result = yield* Effect.promise(() =>
						stub.retractCommentVote({
							commentId: args.commentId,
							voterId: user.id,
						}),
					);
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
				} catch (err) {
					if (err instanceof CommentNotFoundError) {
						throw new GraphQLError(err.message, {
							extensions: {code: "COMMENT_NOT_FOUND"},
						});
					}
					throw err;
				}
			}),
		},
		/**
		 * Edit a comment's body (T12). `Auth.required` enforces sign-in;
		 * ownership is enforced inside the per-post `PanoPost` Agent. The
		 * frontend only knows the comment id, so we lean on `comment_view`'s
		 * denormalized `post_id` to route the RPC into the correct DO
		 * (mirrors `voteOnComment` from T11).
		 */
		editComment: {
			type: new GraphQLNonNull(CommentType),
			args: {
				id: {type: new GraphQLNonNull(GraphQLID)},
				body: {type: new GraphQLNonNull(GraphQLString)},
			},
			resolve: resolver(function* (_source, args: {id: string; body: string}) {
				const {user} = yield* Auth.required;
				const env = yield* CloudflareEnv;

				const trimmed = (args.body ?? "").trim();
				if (trimmed.length === 0) {
					throw new GraphQLError("yorum boş olamaz", {
						extensions: {code: "BODY_REQUIRED"},
					});
				}
				if (args.body.length > 5_000) {
					throw new GraphQLError("yorum en fazla 5000 karakter olabilir", {
						extensions: {code: "BODY_TOO_LONG"},
					});
				}

				const postId = yield* Effect.promise(() => lookupCommentPostId(env.PHOENIX_DB, args.id));
				if (!postId) {
					throw new GraphQLError("comment not found", {
						extensions: {code: "COMMENT_NOT_FOUND"},
					});
				}
				const stub = env.PANO_POST.get(env.PANO_POST.idFromName(postId));
				const result = yield* Effect.promise(() =>
					stub.editComment({commentId: args.id, actorId: user.id, body: args.body}).then(
						(value) => ({ok: true as const, value}),
						(error: unknown) => ({ok: false as const, error}),
					),
				);
				if (!result.ok) {
					throw mapCommentMutationError(result.error);
				}
				const r = result.value;
				return {
					id: r.commentId,
					parentId: r.parentId,
					author: r.authorName,
					authorId: r.authorId,
					body: r.body,
					score: r.score,
					createdAt: r.createdAt,
					// EditCommentResult carries updatedAt; mirror it onto the
					// `Comment` shape so the "düzenlendi" indicator picks it up
					// immediately after a successful edit (T17).
					updatedAt: r.updatedAt,
				} satisfies CommentRow;
			}),
		},
		/**
		 * Soft-delete a comment (T12). `Auth.required` + ownership inside the
		 * Agent. Reply-aware: the per-DO read and the cross-product
		 * `comment_view` projection both treat a deleted-with-children
		 * comment as `[silindi]` (preserve thread shape) and a deleted-leaf
		 * as fully removed. The SDL returns the deleted comment id (mirrors
		 * `deletePost` / `deleteDefinition`).
		 */
		deleteComment: {
			type: new GraphQLNonNull(GraphQLString),
			args: {id: {type: new GraphQLNonNull(GraphQLID)}},
			resolve: resolver(function* (_source, args: {id: string}) {
				const {user} = yield* Auth.required;
				const env = yield* CloudflareEnv;
				const postId = yield* Effect.promise(() => lookupCommentPostId(env.PHOENIX_DB, args.id));
				if (!postId) {
					throw new GraphQLError("comment not found", {
						extensions: {code: "COMMENT_NOT_FOUND"},
					});
				}
				const stub = env.PANO_POST.get(env.PANO_POST.idFromName(postId));
				const result = yield* Effect.promise(() =>
					stub.deleteComment({commentId: args.id, actorId: user.id}).then(
						(value) => ({ok: true as const, value}),
						(error: unknown) => ({ok: false as const, error}),
					),
				);
				if (!result.ok) {
					throw mapCommentMutationError(result.error);
				}
				return result.value.commentId;
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
