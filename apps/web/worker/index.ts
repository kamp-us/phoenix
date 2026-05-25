import {routeAgentRequest} from "agents";
import {Effect} from "effect";
import {Hono} from "hono";
import {z} from "zod";
import {AdminRuntime} from "./admin/runtime";
import {livePublishContext} from "./fate/live";
import {handleLiveRequest} from "./fate/live-route";
import {FateRuntime, toSessionData, validateSessionCookie} from "./fate/runtime";
import {fateServer} from "./fate/server";
import {PanoAdmin} from "./features/pano/PanoAdmin";
import {Pasaport} from "./features/pasaport/Pasaport";
import {PasaportAdmin} from "./features/pasaport/PasaportAdmin";
import {SozlukAdmin} from "./features/sozluk/SozlukAdmin";
import {AdminAuth} from "./services";

// The one Durable Object in phoenix: cross-isolate live fan-out over SSE (ADR
// 0023). Exported here so wrangler's `LIVE_DO` binding can resolve the class.
export {LiveDO} from "./fate/live-do";

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

// Writes go straight to `PHOENIX_DB` via the SozlukAdmin service.
// Idempotent: re-running with the same `(authorId, body)` skips the existing
// row. `AdminAuth.required` gates on `ENVIRONMENT === "development"`.
app.post("/api/admin/sozluk/upsert-term", async (c) => {
	const parsed = upsertTermSchema.safeParse(await c.req.json());
	if (!parsed.success) return c.json({error: "invalid input", issues: parsed.error.issues}, 400);
	const {slug, title, definitions} = parsed.data;

	const runtime = AdminRuntime.make(c.env);
	try {
		return await runtime.runPromise(
			Effect.gen(function* () {
				yield* AdminAuth.required;
				const sozlukAdmin = yield* SozlukAdmin;
				const result = yield* sozlukAdmin.seedTerm({slug, title, definitions});
				return c.json({slug, ...result});
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

// Drop the term_summary + definition_view + vote rows for the given slugs in
// one D1 pass. `sozluk_stats` recomputes from what's left. `AdminAuth.required`
// gates on `ENVIRONMENT === "development"`.
app.post("/api/admin/sozluk/clear", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {slugs?: string[]};
	const slugs = body.slugs ?? [];

	const runtime = AdminRuntime.make(c.env);
	try {
		return await runtime.runPromise(
			Effect.gen(function* () {
				yield* AdminAuth.required;
				const sozlukAdmin = yield* SozlukAdmin;
				const result = yield* sozlukAdmin.clearAllTerms(slugs);
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

// Dev-only pano admin endpoint. Backs `pnpm pano:import`. Routes through the
// admin runtime + `AdminAuth.required` + `PanoAdmin.seedPosts` — same shape as
// the sozluk admin endpoints. Gated on `ENVIRONMENT === "development"`.
const panoSeedSchema = z.object({
	clear: z.boolean().optional(),
});

app.post("/api/admin/pano/seed", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as unknown;
	const parsed = panoSeedSchema.safeParse(body);
	if (!parsed.success) return c.json({error: "invalid input", issues: parsed.error.issues}, 400);

	const runtime = AdminRuntime.make(c.env);
	try {
		return await runtime.runPromise(
			Effect.gen(function* () {
				yield* AdminAuth.required;
				const panoAdmin = yield* PanoAdmin;
				const result = yield* panoAdmin.seedPosts({
					...(parsed.data.clear !== undefined ? {clear: parsed.data.clear} : {}),
				});
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
	const runtime = FateRuntime.make(c.env, c.req.raw, null);
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

// The SSE live transport (ADR 0023). Served from the `LiveDO` Durable Object —
// it builds NO per-request `ManagedRuntime` (the DO relays inline-published
// data; no Effect runtime in the live path). Mounted before `/fate` so the more
// specific path wins. Both GET (open stream) and POST (control) authenticate the
// better-auth session cookie at connect.
app.all("/fate/live", (c) => handleLiveRequest(c));

// fate native protocol (ADR 0015–0017). The single data plane for the SPA.
// The route owns the per-request runtime: it validates the session, builds a
// `ManagedRuntime` with that session baked into the `Auth` layer, hands it to
// fate via `adapterContext`, and disposes it in `finally` via
// `executionCtx.waitUntil` so disposal doesn't block the response.
app.post("/fate", async (c) => {
	// Validate the session through a minimal Pasaport-only runtime; the request
	// runtime is then built once with the resolved session attached to `Auth`.
	const session = await validateSessionCookie(c.env, c.req.raw);
	const sessionData = toSessionData(session);

	const runtime = FateRuntime.make(c.env, c.req.raw, sessionData);
	try {
		// Run the operation inside the live publish context so a mutation's `live.*`
		// publishes can resolve the `LIVE_DO` binding and `waitUntil` the fan-out
		// (it doesn't block the response). The publish carries inline-resolved data.
		return await livePublishContext.run(
			{env: c.env, waitUntil: (p: Promise<unknown>) => c.executionCtx.waitUntil(p)},
			() => fateServer.handleRequest(c.req.raw, {request: c.req.raw, runtime}),
		);
	} finally {
		c.executionCtx.waitUntil(runtime.dispose());
	}
});

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
