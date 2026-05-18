import {routeAgentRequest} from "agents";
import {Effect} from "effect";
import {createYoga} from "graphql-yoga";
import {Hono} from "hono";
import {z} from "zod";
import {AdminRuntime} from "./admin/runtime";
import {addComment, submitPost} from "./features/pano/module";
import {SEED_POSTS} from "./features/pano/seed";
import type {Session} from "./features/pasaport/auth";
import {Pasaport} from "./features/pasaport/Pasaport";
import {PasaportAdmin} from "./features/pasaport/PasaportAdmin";
import {clearAllTerms, seedTerm} from "./features/sozluk/module";
import type {EffectContext} from "./graphql/resolver";
import {GraphQLRuntime, type SessionData} from "./graphql/runtime";
import {printSchemaSDL, schema} from "./graphql/schema";
import {AdminAuth} from "./services";

// Per ADR 0009 (d1-direct): no product DOs, no projection workflow.
// Every product surface (sozluk, pano, pasaport) runs as module functions
// against `PHOENIX_DB`. Worker exports no DO or Workflow classes.

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

// Writes go straight to `PHOENIX_DB` via the sozluk module.
// Idempotent: re-running with the same `(authorId, body)` skips the existing
// row. Gated on `ENVIRONMENT === "development"`.
app.post("/api/admin/sozluk/upsert-term", async (c) => {
	if ((c.env.ENVIRONMENT as string) !== "development") return c.text("Forbidden", 403);
	const parsed = upsertTermSchema.safeParse(await c.req.json());
	if (!parsed.success) return c.json({error: "invalid input", issues: parsed.error.issues}, 400);
	const {slug, title, definitions} = parsed.data;
	const result = await seedTerm(c.env, {slug, title, definitions});
	return c.json({slug, ...result});
});

// Drop the term_summary + definition_view + vote rows for the
// given slugs in one D1 pass. `sozluk_stats` recomputes from what's left.
app.post("/api/admin/sozluk/clear", async (c) => {
	if ((c.env.ENVIRONMENT as string) !== "development") return c.text("Forbidden", 403);
	const body = (await c.req.json().catch(() => ({}))) as {slugs?: string[]};
	const slugs = body.slugs ?? [];
	const result = await clearAllTerms(c.env, slugs);
	return c.json(result);
});

// Dev-only pano admin endpoint. Backs `pnpm pano:import`. Post-d1-direct,
// every write goes straight to `PHOENIX_DB` via the
// `submitPost` / `addComment` module functions — no DO RPC. Gated on
// `ENVIRONMENT === "development"`.
const panoSeedSchema = z.object({
	clear: z.boolean().optional(),
});

app.post("/api/admin/pano/seed", async (c) => {
	if ((c.env.ENVIRONMENT as string) !== "development") return c.text("Forbidden", 403);
	const body = (await c.req.json().catch(() => ({}))) as unknown;
	const parsed = panoSeedSchema.safeParse(body);
	if (!parsed.success) return c.json({error: "invalid input", issues: parsed.error.issues}, 400);

	const cleared = {posts: 0, comments: 0};
	if (parsed.data.clear) {
		const postsBefore = await c.env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) AS count FROM post_summary",
		).first<{count: number}>();
		const commentsBefore = await c.env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) AS count FROM comment_view",
		).first<{count: number}>();
		cleared.posts = postsBefore?.count ?? 0;
		cleared.comments = commentsBefore?.count ?? 0;
		await c.env.PHOENIX_DB.batch([
			c.env.PHOENIX_DB.prepare("DELETE FROM comment_vote"),
			c.env.PHOENIX_DB.prepare("DELETE FROM post_vote"),
			c.env.PHOENIX_DB.prepare("DELETE FROM comment_view"),
			c.env.PHOENIX_DB.prepare("DELETE FROM post_summary"),
			c.env.PHOENIX_DB.prepare("DELETE FROM pano_stats"),
		]);
	}

	const postIds: string[] = [];
	let inserted = 0;
	for (const seed of SEED_POSTS) {
		const post = await submitPost(c.env, {
			title: seed.title,
			...(seed.url ? {url: seed.url} : {}),
			...(seed.body ? {body: seed.body} : {}),
			authorId: seed.authorId,
			authorName: seed.authorName,
			tags: seed.tags,
		});
		postIds.push(post.postId);
		inserted++;

		// Two-pass: top-level first so children can reference parents.
		const insertedIds: string[] = [];
		for (const cmt of seed.comments) {
			const parentId = cmt.parentIdx != null ? (insertedIds[cmt.parentIdx] ?? null) : null;
			const result = await addComment(c.env, {
				postId: post.postId,
				authorId: cmt.authorId,
				authorName: cmt.authorName,
				body: cmt.body,
				...(parentId != null ? {parentId} : {}),
			});
			insertedIds.push(result.commentId);
		}
	}

	return c.json({inserted, postIds, cleared});
});

// Dev-only Pasaport admin endpoint: backfill `user_profile` rows in PHOENIX_DB
// for every existing user. Idempotent — re-runs overwrite the same identity
// values per user, no side effects on counters. `AdminAuth.required` gates the
// route on `ENVIRONMENT === "development"`; the admin runtime provides
// `PasaportAdmin`.
app.post("/api/admin/pasaport/backfill-profiles", async (c) => {
	const runtime = AdminRuntime.make(c.env);
	try {
		return await runtime.runPromise(
			Effect.gen(function* () {
				yield* AdminAuth.required;
				const pasaportAdmin = yield* PasaportAdmin;
				const result = yield* pasaportAdmin.backfillProfiles;
				return c.json(result);
			}).pipe(
				Effect.catchTag("@phoenix/AdminAuth/Forbidden", () =>
					Effect.succeed(c.text("Forbidden", 403)),
				),
			),
		);
	} finally {
		await runtime.dispose();
	}
});

// Better Auth handler — wired straight into the Hono router (ADR 0009).
// Single global auth realm; `Pasaport.handleAuth` constructs a better-auth
// instance per request against `env.PHOENIX_DB`.
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
	const runtime = GraphQLRuntime.make(c.env, c.req.raw, null);
	try {
		return await runtime.runPromise(
			Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				return yield* pasaport.handleAuth(c.req.raw);
			}),
		);
	} finally {
		await runtime.dispose();
	}
});

// Agent WebSocket subscriptions (T16). No product Agent DOs remain on the
// worker post-d1-direct, so this handler currently has nothing to dispatch
// to and always returns 404. Kept as a stub: future per-atom Agents (chat,
// presence, künye, …) will plug in here without changing the router shape.
app.all("/agents/*", async (c) => {
	const res = await routeAgentRequest(c.req.raw, c.env);
	return res ?? c.text("Not Found", 404);
});

// SDL for relay-compiler (`pnpm schema:fetch`).
app.get("/graphql/schema", (c) => c.text(printSchemaSDL()));

// Per-request: validate session via the Pasaport service, build a ManagedRuntime
// that provides services to resolvers (Auth, CloudflareEnv, RequestContext,
// Pasaport, …), dispose after. Yoga's response carries its own Response class
// (from @whatwg-node/server) which fails workerd's `instanceof Response` check;
// rewrap with the runtime-native Response constructor.
app.on(["GET", "POST"], "/graphql", async (c) => {
	// Validate the session through a short-lived runtime; resolvers run inside
	// a separate runtime constructed with the resolved session attached to the
	// `Auth` layer.
	const sessionRuntime = GraphQLRuntime.make(c.env, c.req.raw, null);
	let session: Session | null = null;
	try {
		session = await sessionRuntime.runPromise(
			Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				return yield* pasaport.validateSession(c.req.raw.headers);
			}),
		);
	} finally {
		await sessionRuntime.dispose();
	}
	const sessionData: SessionData = session ? {user: session.user, session: session.session} : null;

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
