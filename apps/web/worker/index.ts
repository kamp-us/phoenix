import {createYoga} from "graphql-yoga";
import {Hono} from "hono";
import {z} from "zod";
import type {EffectContext} from "./graphql/resolver";
import {GraphQLRuntime} from "./graphql/runtime";
import {printSchemaSDL, schema} from "./graphql/schema";

export {Pasaport} from "./features/pasaport/Pasaport";
export {Sozluk} from "./features/sozluk/Sozluk";
export {Pano} from "./features/pano/Pano";

const app = new Hono<{Bindings: Env}>();

app.get("/api/health", (c) => c.json({status: "ok", environment: c.env.ENVIRONMENT}));

// Dev-only sözlük admin endpoints. Backs the `pnpm sozluk:import` script that
// pulls MDX content from the legacy monorepo into the Sozluk DO. Gated on
// ENVIRONMENT === "development" — the binding is `vars.ENVIRONMENT` in
// wrangler.jsonc and is overridden per-deploy.
const upsertTermSchema = z.object({
	slug: z.string().min(1),
	title: z.string().min(1),
	definitions: z
		.array(
			z.object({
				authorId: z.string().min(1),
				authorName: z.string().min(1),
				body: z.string().min(1),
				score: z.number().int().optional(),
			}),
		)
		.min(1),
});

app.post("/api/admin/sozluk/upsert-term", async (c) => {
	if ((c.env.ENVIRONMENT as string) !== "development") return c.text("Forbidden", 403);
	const parsed = upsertTermSchema.safeParse(await c.req.json());
	if (!parsed.success) return c.json({error: "invalid input", issues: parsed.error.issues}, 400);
	const stub = c.env.SOZLUK.get(c.env.SOZLUK.idFromName("kampus"));
	return c.json(await stub.upsertTerm(parsed.data));
});

app.post("/api/admin/sozluk/clear", async (c) => {
	if ((c.env.ENVIRONMENT as string) !== "development") return c.text("Forbidden", 403);
	const stub = c.env.SOZLUK.get(c.env.SOZLUK.idFromName("kampus"));
	return c.json(await stub.clearAll());
});

// Better Auth handler — forwarded to the Pasaport DO.
// Single global Pasaport instance for now (one auth realm); shard later if needed.
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
	const stub = c.env.PASAPORT.get(c.env.PASAPORT.idFromName("kampus"));
	return stub.fetch(c.req.raw);
});

// SDL for relay-compiler (`pnpm schema:fetch`).
app.get("/graphql/schema", (c) => c.text(printSchemaSDL()));

// Per-request: validate session via Pasaport, build a ManagedRuntime that
// provides services to resolvers (Auth, CloudflareEnv, RequestContext),
// dispose after. Yoga's response carries its own Response class (from
// @whatwg-node/server) which fails workerd's `instanceof Response` check;
// rewrap with the runtime-native Response constructor.
app.on(["GET", "POST"], "/graphql", async (c) => {
	const pasaport = c.env.PASAPORT.get(c.env.PASAPORT.idFromName("kampus"));
	const sessionData = await pasaport.validateSession(c.req.raw.headers);

	const runtime = GraphQLRuntime.make(c.env, c.req.raw, sessionData);
	try {
		const yoga = createYoga<EffectContext<GraphQLRuntime.Context>>({
			graphqlEndpoint: "/graphql",
			schema,
			graphiql: true,
			logging: true,
			context: () => ({runtime}),
		});
		const r = await yoga.fetch(c.req.raw);
		return new Response(r.body, {
			status: r.status,
			statusText: r.statusText,
			headers: r.headers,
		});
	} finally {
		await runtime.dispose();
	}
});

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
