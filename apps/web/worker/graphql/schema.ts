import {Effect} from "effect";
import {
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
	lexicographicSortSchema,
	printSchema,
} from "graphql";
import type {VoteValue} from "../features/pano/Pano";
import type {CommentRow, PostPage, PostTagRow} from "../features/pano/PanoPost";
import {
	listPostSummaries,
	type PostSort,
	type PostSummaryRow,
} from "../features/pano/postSummaryReader";
import {UsernameValidationError} from "../features/pasaport/Pasaport";
import type {DefinitionRow, ListSort, TermPage, TermSummary} from "../features/sozluk/Sozluk";
import {DefinitionNotFoundError, DefinitionValidationError} from "../features/sozluk/SozlukTerm";
import {listTermSummaries, type TermSummaryRow} from "../features/sozluk/termSummaryReader";
import {lookupDefinitionTermSlug, readMyVote} from "../features/sozluk/userVoteReader";
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
		 */
		myVote: {
			type: GraphQLInt,
			resolve: resolver(function* (parent: DefinitionRow) {
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
 * Single Post type backs both list (PostSummaryRow from D1) and detail
 * (PostPage from per-post DO) queries — same shape on both code paths today,
 * kept as separate type aliases so they can diverge without touching the
 * GraphQL layer.
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
		discuss: {value: "discuss"},
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
	},
});

const VoteResultType = new GraphQLObjectType({
	name: "VoteResult",
	fields: {
		score: {type: new GraphQLNonNull(GraphQLInt)},
	},
});

const VoteInputType = new GraphQLInputObjectType({
	name: "VoteInput",
	fields: {
		targetId: {type: new GraphQLNonNull(GraphQLID)},
		/** -1 | 0 | 1 — runtime-validated in the resolver. */
		value: {type: new GraphQLNonNull(GraphQLInt)},
	},
});

interface VoteInput {
	targetId: string;
	value: number;
}

/**
 * Narrow `value: number` to {-1, 0, 1} or throw the user-facing GraphQL error.
 * Centralized so both vote resolvers report the same wording.
 */
function parseVoteValue(raw: number): VoteValue {
	if (raw === -1 || raw === 0 || raw === 1) return raw;
	throw new GraphQLError("Invalid vote value");
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
						score: result.score,
						createdAt: result.createdAt,
						updatedAt: result.updatedAt,
					} satisfies DefinitionRow;
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
						score: result.score,
						createdAt: result.createdAt,
						updatedAt: result.updatedAt,
					} satisfies DefinitionRow;
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
		voteOnPost: {
			type: new GraphQLNonNull(VoteResultType),
			args: {input: {type: new GraphQLNonNull(VoteInputType)}},
			resolve: resolver(function* (_source, args: {input: VoteInput}) {
				const auth = yield* Auth;
				if (!auth.user) throw new GraphQLError("Sign in required");
				const value = parseVoteValue(args.input.value);
				const env = yield* CloudflareEnv;
				const stub = env.PANO.get(env.PANO.idFromName("kampus"));
				return yield* Effect.promise(() =>
					stub.voteOnPost({
						userId: auth.user!.id,
						postId: args.input.targetId,
						value,
					}),
				);
			}),
		},
		voteOnComment: {
			type: new GraphQLNonNull(VoteResultType),
			args: {input: {type: new GraphQLNonNull(VoteInputType)}},
			resolve: resolver(function* (_source, args: {input: VoteInput}) {
				const auth = yield* Auth;
				if (!auth.user) throw new GraphQLError("Sign in required");
				const value = parseVoteValue(args.input.value);
				const env = yield* CloudflareEnv;
				const stub = env.PANO.get(env.PANO.idFromName("kampus"));
				return yield* Effect.promise(() =>
					stub.voteOnComment({
						userId: auth.user!.id,
						commentId: args.input.targetId,
						value,
					}),
				);
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
