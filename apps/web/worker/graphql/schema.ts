import {
	GraphQLID,
	GraphQLNonNull,
	GraphQLObjectType,
	GraphQLSchema,
	GraphQLString,
	lexicographicSortSchema,
	printSchema,
} from "graphql";
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
	},
});

export const schema = new GraphQLSchema({query: QueryType});

/**
 * Stable, sorted SDL printout — used by relay-compiler in apps/web
 * to generate __generated__ artifacts.
 */
export const printSchemaSDL = (): string => printSchema(lexicographicSortSchema(schema));
