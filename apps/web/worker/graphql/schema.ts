import {createSchema} from "graphql-yoga";

const typeDefs = /* GraphQL */ `
	type Query {
		health: Health!
	}

	type Health {
		status: String!
		environment: String!
	}
`;

export type SchemaContext = Env & ExecutionContext;

export const schema = createSchema<SchemaContext>({
	typeDefs,
	resolvers: {
		Query: {
			health: (_, __, ctx) => ({
				status: "ok",
				environment: ctx.ENVIRONMENT,
			}),
		},
	},
});
