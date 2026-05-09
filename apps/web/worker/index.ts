import {createYoga} from "graphql-yoga";
import {Hono} from "hono";
import {type SchemaContext, schema} from "./graphql/schema";

const app = new Hono<{Bindings: Env}>();

app.get("/api/health", (c) => c.json({status: "ok", environment: c.env.ENVIRONMENT}));

const yoga = createYoga<SchemaContext>({
	graphqlEndpoint: "/graphql",
	schema,
	graphiql: true,
	logging: true,
});

// Yoga's response carries its own Response class (from @whatwg-node/server),
// which fails workerd's `instanceof Response` check on the way out. Rewrap
// with the runtime's native Response constructor.
app.on(["GET", "POST"], "/graphql", async (c) => {
	const r = await yoga.fetch(c.req.raw, c.env, c.executionCtx);
	return new Response(r.body, {
		status: r.status,
		statusText: r.statusText,
		headers: r.headers,
	});
});

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
