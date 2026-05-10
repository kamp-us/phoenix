import {id} from "@usirin/forge";
import {routeAgentRequest} from "agents";
import {createYoga} from "graphql-yoga";
import {Hono} from "hono";
import {z} from "zod";
import {SEED_POSTS} from "./features/pano/seed";
import type {EffectContext} from "./graphql/resolver";
import {GraphQLRuntime} from "./graphql/runtime";
import {printSchemaSDL, schema} from "./graphql/schema";

export {PanoPost} from "./features/pano/PanoPost";
export {Pasaport} from "./features/pasaport/Pasaport";
// Per-atom Agent classes own all read + write paths (ADR 0005 / 0006). The
// legacy singleton Sozluk / Pano DOs were deleted in T18 via the wrangler
// `delete_classes` migration.
export {SozlukTerm} from "./features/sozluk/SozlukTerm";
// View-layer projection workflow (binding: PHOENIX_PROJECTION). Skeleton
// lives in worker/view/PhoenixProjection.ts; step bodies are no-ops in T1
// and get filled in per event kind across T2..T15.
export {PhoenixProjection} from "./view/PhoenixProjection";

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

// Per ADR 0005/0007 the seed dispatches into per-term `SozlukTerm` instances
// (`idFromName(slug)`) instead of the singleton `Sozluk`. The seed call writes
// definitions atomically, emits a single `TermChanged` event per term, and the
// projection populates `term_summary` for cross-entity reads.
app.post("/api/admin/sozluk/upsert-term", async (c) => {
	if ((c.env.ENVIRONMENT as string) !== "development") return c.text("Forbidden", 403);
	const parsed = upsertTermSchema.safeParse(await c.req.json());
	if (!parsed.success) return c.json({error: "invalid input", issues: parsed.error.issues}, 400);
	const {slug, title, definitions} = parsed.data;
	const stub = c.env.SOZLUK_TERM.get(c.env.SOZLUK_TERM.idFromName(slug));
	const result = await stub.seed({title, definitions});
	return c.json({slug, ...result});
});

// Dev-only namespace clear. Walks the slugs the caller provides (plus a default
// "kampus" sweep for the legacy seed) and wipes each per-term DO. Term-level
// `term_summary` rows in PHOENIX_DB are also cleared so re-seeding starts clean.
app.post("/api/admin/sozluk/clear", async (c) => {
	if ((c.env.ENVIRONMENT as string) !== "development") return c.text("Forbidden", 403);
	const body = (await c.req.json().catch(() => ({}))) as {slugs?: string[]};
	const slugs = body.slugs ?? [];

	let definitions = 0;
	let terms = 0;
	for (const slug of slugs) {
		const stub = c.env.SOZLUK_TERM.get(c.env.SOZLUK_TERM.idFromName(slug));
		const r = await stub.clearAll();
		definitions += r.definitions;
		if (r.term) terms++;
	}

	// Clear the cross-entity views — re-seed will rebuild via projection.
	await c.env.PHOENIX_DB.prepare("DELETE FROM term_summary").run();
	await c.env.PHOENIX_DB.prepare("DELETE FROM sozluk_stats").run();

	return c.json({terms, definitions});
});

// Dev-only pano admin endpoints. Mirrors the sozluk seed surface but for the
// per-post `PanoPost` Agents (`idFromName(postId)`). Each call seeds one post
// via its DO; a single `PostChanged` event per post hydrates `post_summary`.
const panoSeedSchema = z.object({
	clear: z.boolean().optional(),
	postIds: z.array(z.string().min(1)).optional(),
});

app.post("/api/admin/pano/seed", async (c) => {
	if ((c.env.ENVIRONMENT as string) !== "development") return c.text("Forbidden", 403);
	const body = (await c.req.json().catch(() => ({}))) as unknown;
	const parsed = panoSeedSchema.safeParse(body);
	if (!parsed.success) return c.json({error: "invalid input", issues: parsed.error.issues}, 400);

	const cleared = {posts: 0, comments: 0, tags: 0};
	if (parsed.data.clear && parsed.data.postIds?.length) {
		for (const postId of parsed.data.postIds) {
			const stub = c.env.PANO_POST.get(c.env.PANO_POST.idFromName(postId));
			const r = await stub.clearAll();
			if (r.post) cleared.posts++;
			cleared.comments += r.comments;
			cleared.tags += r.tags;
		}
		await c.env.PHOENIX_DB.prepare("DELETE FROM post_summary").run();
		await c.env.PHOENIX_DB.prepare("DELETE FROM pano_stats").run();
	}

	const postIds: string[] = [];
	let inserted = 0;
	for (const seed of SEED_POSTS) {
		const postId = id("post");
		postIds.push(postId);
		const stub = c.env.PANO_POST.get(c.env.PANO_POST.idFromName(postId));
		const result = await stub.seed({
			title: seed.title,
			...(seed.url ? {url: seed.url} : {}),
			...(seed.body ? {body: seed.body} : {}),
			authorId: seed.authorId,
			authorName: seed.authorName,
			score: seed.score,
			tags: seed.tags,
			comments: seed.comments.map((c) => ({
				authorId: c.authorId,
				authorName: c.authorName,
				body: c.body,
				score: c.score,
				...(c.parentIdx != null ? {parentIdx: c.parentIdx} : {}),
			})),
		});
		if (result.created) inserted++;
	}

	return c.json({inserted, postIds, cleared});
});

// Dev-only Pasaport admin endpoint: backfill `user_profile` rows in PHOENIX_DB
// for every existing Pasaport user. Idempotent — projection's `last_event_id`
// guard de-duplicates re-runs. Use after applying view migration 0002 the
// first time, or after seeding accounts directly into Pasaport in dev.
app.post("/api/admin/pasaport/backfill-profiles", async (c) => {
	if ((c.env.ENVIRONMENT as string) !== "development") return c.text("Forbidden", 403);
	const stub = c.env.PASAPORT.get(c.env.PASAPORT.idFromName("kampus"));
	const result = await stub.backfillProfiles();
	return c.json(result);
});

// Better Auth handler — forwarded to the Pasaport DO.
// Single global Pasaport instance for now (one auth realm); shard later if needed.
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
	const stub = c.env.PASAPORT.get(c.env.PASAPORT.idFromName("kampus"));
	return stub.fetch(c.req.raw);
});

// Agent WebSocket subscriptions (T16). The Agents SDK client (`useAgent`)
// connects to `/agents/<class-kebab>/<name>` and expects a 101 WebSocket
// upgrade. `routeAgentRequest` walks the env bindings and dispatches to the
// matching DO class (SozlukTerm / PanoPost / Pasaport). Returns null if the
// request isn't an agent request, in which case Hono falls through to the
// next handler.
app.all("/agents/*", async (c) => {
	const res = await routeAgentRequest(c.req.raw, c.env);
	return res ?? c.text("Not Found", 404);
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
