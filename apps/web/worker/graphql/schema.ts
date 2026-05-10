import {Effect} from "effect";
import {
	GraphQLEnumType,
	GraphQLID,
	GraphQLInt,
	GraphQLList,
	GraphQLNonNull,
	GraphQLObjectType,
	GraphQLSchema,
	GraphQLString,
	lexicographicSortSchema,
	printSchema,
} from "graphql";
import type {
	CommentRow,
	PostPage,
	PostSort,
	PostSummary,
	PostTag,
} from "../features/pano/Pano";
import type {
	DefinitionRow,
	ListSort,
	TermPage,
	TermSummary,
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

const UserType = new GraphQLObjectType({
	name: "User",
	fields: {
		id: {type: new GraphQLNonNull(GraphQLID)},
		email: {type: new GraphQLNonNull(GraphQLString)},
		name: {type: GraphQLString},
		image: {type: GraphQLString},
	},
});

const DefinitionType = new GraphQLObjectType<DefinitionRow>({
	name: "Definition",
	fields: {
		id: {type: new GraphQLNonNull(GraphQLID)},
		body: {type: new GraphQLNonNull(GraphQLString)},
		author: {type: new GraphQLNonNull(GraphQLString)},
		score: {type: new GraphQLNonNull(GraphQLInt)},
		createdAt: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (d) => d.createdAt.toISOString(),
		},
		updatedAt: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (d) => d.updatedAt.toISOString(),
		},
	},
});

/**
 * Single Term type backs both list (TermSummary) and detail (TermPage)
 * queries. Fields specific to one shape (excerpt, definitions, firstAt,
 * lastEdit) resolve to null / empty when the source doesn't carry them —
 * matches GraphQL execution: clients only request what they need.
 */
const TermType: GraphQLObjectType = new GraphQLObjectType<TermSummary | TermPage>({
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
			resolve: (s) => ("firstAt" in s ? s.firstAt.toISOString() : null),
		},
		lastEdit: {
			type: GraphQLString,
			resolve: (s) => ("lastEdit" in s ? s.lastEdit.toISOString() : null),
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

const TagType = new GraphQLObjectType<PostTag>({
	name: "Tag",
	fields: {
		kind: {type: new GraphQLNonNull(GraphQLString)},
		label: {type: new GraphQLNonNull(GraphQLString)},
	},
});

/**
 * Single Post type backs both list (PostSummary) and detail (PostPage)
 * queries — same shape on both code paths today, kept as separate type
 * aliases on the DO so they can diverge without touching the GraphQL layer.
 */
const PostType = new GraphQLObjectType<PostSummary | PostPage>({
	name: "Post",
	fields: () => ({
		id: {type: new GraphQLNonNull(GraphQLID)},
		slug: {type: GraphQLString},
		title: {type: new GraphQLNonNull(GraphQLString)},
		url: {type: GraphQLString},
		host: {type: GraphQLString},
		body: {type: GraphQLString},
		author: {type: new GraphQLNonNull(GraphQLString)},
		score: {type: new GraphQLNonNull(GraphQLInt)},
		commentCount: {type: new GraphQLNonNull(GraphQLInt)},
		createdAt: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (p) => p.createdAt.toISOString(),
		},
		tags: {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TagType))),
			resolve: (p) => p.tags,
		},
	}),
});

const CommentType = new GraphQLObjectType<CommentRow>({
	name: "Comment",
	fields: {
		id: {type: new GraphQLNonNull(GraphQLID)},
		parentId: {type: GraphQLID},
		author: {type: new GraphQLNonNull(GraphQLString)},
		body: {type: new GraphQLNonNull(GraphQLString)},
		score: {type: new GraphQLNonNull(GraphQLInt)},
		createdAt: {
			type: new GraphQLNonNull(GraphQLString),
			resolve: (c) => c.createdAt.toISOString(),
		},
	},
});

const PostSortEnum = new GraphQLEnumType({
	name: "PostSort",
	values: {
		hot: {value: "hot"},
		new: {value: "new"},
		top: {value: "top"},
	},
});

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
				return {
					id: auth.user.id,
					email: auth.user.email,
					name: auth.user.name,
					image: auth.user.image,
				};
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
				const stub = env.SOZLUK.get(env.SOZLUK.idFromName("kampus"));
				return yield* Effect.promise(() =>
					stub.listTerms({
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
				const stub = env.SOZLUK.get(env.SOZLUK.idFromName("kampus"));
				return yield* Effect.promise(() => stub.getTerm(args.slug));
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
				const stub = env.PANO.get(env.PANO.idFromName("kampus"));
				return yield* Effect.promise(() =>
					stub.listPosts({
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
				const stub = env.PANO.get(env.PANO.idFromName("kampus"));
				return yield* Effect.promise(() => stub.getPost(args.idOrSlug));
			}),
		},
		postComments: {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(CommentType))),
			args: {postId: {type: new GraphQLNonNull(GraphQLString)}},
			resolve: resolver(function* (_source, args: {postId: string}) {
				const env = yield* CloudflareEnv;
				const stub = env.PANO.get(env.PANO.idFromName("kampus"));
				return yield* Effect.promise(() => stub.listComments(args.postId));
			}),
		},
	},
});

export const schema = new GraphQLSchema({query: QueryType});

/**
 * Stable, sorted SDL printout — used by relay-compiler in apps/web
 * to generate __generated__ artifacts.
 */
export const printSchemaSDL = (): string => printSchema(lexicographicSortSchema(schema));
