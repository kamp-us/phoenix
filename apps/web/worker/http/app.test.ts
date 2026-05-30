/**
 * HTTP surface on `HttpRouter` + `HttpApiBuilder`, Hono-free (task 4, ADR 0027).
 *
 * Drives the *compiled* application — `HttpRouter.toHttpEffect(makeAppLive(...))`,
 * the exact effect the worker returns as `fetch` — over a `node:sqlite`-backed
 * D1 (the same stand-in the fate bridge tests use). Each "request" provides the
 * worker-level services (`Cloudflare.Request`, `WorkerEnvironment`,
 * `WorkerExecutionContext`, `HttpServerRequest`, `Scope`) exactly as the alchemy
 * worker runtime does, then asserts on the `Response`.
 *
 * Covers the task-4 acceptance criteria end-to-end through the real router:
 *   - `GET /api/health` is an `HttpApiBuilder` group → 200 JSON.
 *   - the `/api/admin/*` seeders are `HttpApiBuilder` groups with schema-decoded
 *     payloads: gated 403 when not allowed; populate D1 + re-resolve over fate
 *     when allowed (the seeder-import path).
 *   - `/api/auth/*` (better-auth) signs a user up against the same D1 tables and
 *     issues a session cookie; that cookie makes an authenticated fate `me`
 *     request succeed end-to-end.
 *
 * Runs in the node pool (workerd harness is task 7).
 */
import * as BetterAuth from "@alchemy.run/better-auth";
import * as Cloudflare from "alchemy/Cloudflare";
import {type BetterAuthOptions, betterAuth as makeBetterAuth} from "better-auth";
import {drizzleAdapter} from "better-auth/adapters/drizzle";
import {bearer} from "better-auth/plugins";
import {drizzle} from "drizzle-orm/d1";
import {Effect} from "effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {createDrizzle} from "../db/Drizzle.ts";
import baselineMigration from "../db/drizzle/migrations/0000_d1_baseline.sql?raw";
import * as schema from "../db/drizzle/schema.ts";
import {makeSqliteD1, type SqliteD1} from "../fate/__support__/sqlite-d1.ts";
import {makeAdminLayer, makeFateLayer} from "../fate/layers.ts";
import {LiveConnections, LiveTopics} from "../features/fate-live/topics.ts";
import {makeAppLive} from "./app.ts";

/**
 * A no-op live layer for the HTTP-surface tests — these cases exercise health /
 * admin / auth / fate, not the live SSE path (the live fan-out has its own
 * `features/fate-live/do.test.ts`). `publish` swallows; the connection RPCs are
 * never hit by these cases.
 */
const liveLayer = Layer.mergeAll(
	Layer.succeed(LiveTopics)(LiveTopics.of({publish: () => Effect.void})),
	Layer.succeed(LiveConnections)(
		LiveConnections.of({
			open: () => Effect.die("live transport not exercised in app.test"),
			subscribe: () => Effect.succeed({ok: true}),
			unsubscribe: () => Effect.succeed({ok: true} as const),
		}),
	),
);

/**
 * The worker derives the admin gate from its env (`index.ts`): the dev-only
 * surfaces open only when `ENVIRONMENT === "development"`. Mirror that derivation
 * here so the regression below ties the closed gate to a non-dev environment.
 */
const adminGateFor = (environment: string): boolean => environment === "development";

let sqlite: SqliteD1;
/** `AppLive` built with the admin env gate open (`adminAllowed = true`). */
let appLayerAllowed: ReturnType<typeof makeAppLive>;
/** Same, but with the gate closed. */
let appLayerDenied: ReturnType<typeof makeAppLive>;
/** Built with the gate derived from a non-development `ENVIRONMENT` (prod). */
let appLayerProd: ReturnType<typeof makeAppLive>;

const ENV = {
	ENVIRONMENT: "development",
	BETTER_AUTH_URL: "http://localhost:3000",
	BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3000",
	BETTER_AUTH_SECRET: "phoenix-test-secret",
} as const;

const EXEC_CTX = {waitUntil: () => {}, passThroughOnException: () => {}};

/**
 * Drive one request through the compiled app. Compiles `appLayer` with
 * `toHttpEffect`, runs the inner app effect with the worker-level services the
 * alchemy runtime would provide (`Cloudflare.Request`/`WorkerEnvironment`/
 * `WorkerExecutionContext` + `HttpServerRequest`), and returns the web
 * `Response`. Everything runs inside one `Scope` so the built layer stays alive
 * for the inner effect.
 */
async function fetch(appLayer: typeof appLayerAllowed, request: Request): Promise<Response> {
	const program = Effect.gen(function* () {
		const app = yield* HttpRouter.toHttpEffect(appLayer);
		const res = yield* app.pipe(
			Effect.provideService(
				HttpServerRequest.HttpServerRequest,
				HttpServerRequest.fromWeb(request),
			),
		);
		return HttpServerResponse.toWeb(res);
	}).pipe(
		Effect.provideService(Cloudflare.Request, request),
		Effect.provideService(Cloudflare.WorkerEnvironment, ENV as never),
		Effect.provideService(Cloudflare.WorkerExecutionContext, EXEC_CTX as never),
		Effect.scoped,
	);
	return Effect.runPromise(program as Effect.Effect<Response>);
}

beforeAll(() => {
	sqlite = makeSqliteD1();
	sqlite.applyMigration(baselineMigration);

	const db = createDrizzle(sqlite.d1);

	// Build a real better-auth instance over the same node:sqlite-backed D1 the
	// rest of the test uses. The deployed worker assembles this via
	// `BetterAuthLive` (`worker/features/pasaport/better-auth-live.ts`), but that Layer needs
	// the full alchemy provider stack (`Random`, `D1Connection`) which doesn't
	// exist in the node test runtime. Constructing the instance directly here and
	// providing it through a hand-rolled Layer over the same `BetterAuth` Context
	// tag is the test-mode equivalent.
	const betterAuthDrizzle = drizzle(sqlite.d1, {schema});
	const testAuthInstance = makeBetterAuth({
		emailAndPassword: {enabled: true},
		database: drizzleAdapter(betterAuthDrizzle, {provider: "sqlite", schema}),
		secret: ENV.BETTER_AUTH_SECRET,
		baseURL: ENV.BETTER_AUTH_URL,
		trustedOrigins: [ENV.BETTER_AUTH_TRUSTED_ORIGINS],
		user: {
			additionalFields: {
				username: {type: "string", required: false, input: false},
			},
		},
		plugins: [bearer()],
	} satisfies BetterAuthOptions);

	const betterAuthLayer = Layer.succeed(BetterAuth.BetterAuth)({
		auth: Effect.succeed(testAuthInstance),
		fetch: Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const response = yield* Effect.promise(() =>
				testAuthInstance.handler(request.source as Request),
			);
			return HttpServerResponse.fromWeb(response);
		}),
	});

	// `makeBetterAuth(...)` returns `Auth<{...specific options}>`; widen to
	// `Parameters<typeof makeFateLayer>[1]` (the `Auth` type re-export, which
	// the deployed worker also satisfies).
	const fateLayer = makeFateLayer(
		db,
		testAuthInstance as unknown as Parameters<typeof makeFateLayer>[1],
	);
	const adminLayer = makeAdminLayer(db);

	appLayerAllowed = makeAppLive({
		fateLayer,
		adminLayer,
		adminAllowed: true,
		liveLayer,
		betterAuthLayer,
	});
	appLayerDenied = makeAppLive({
		fateLayer,
		adminLayer,
		adminAllowed: false,
		liveLayer,
		betterAuthLayer,
	});
	// Gate derived the way the worker derives it, from a non-dev `ENVIRONMENT`.
	appLayerProd = makeAppLive({
		fateLayer,
		adminLayer,
		adminAllowed: adminGateFor("production"),
		liveLayer,
		betterAuthLayer,
	});
});

afterAll(() => {
	sqlite?.close();
});

describe("HTTP surface — HttpApiBuilder + HttpRouter (Hono-free)", () => {
	it("GET /api/health → 200 JSON", async () => {
		const res = await fetch(appLayerAllowed, new Request("https://test.local/api/health"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {status: string; environment: string | null};
		expect(body.status).toBe("ok");
		expect(body.environment).toBe("development");
	});

	it("POST /api/admin/sozluk/upsert-term is gated 403 when admin not allowed", async () => {
		const res = await fetch(
			appLayerDenied,
			new Request("https://test.local/api/admin/sozluk/upsert-term", {
				method: "POST",
				headers: {"content-type": "application/json"},
				body: JSON.stringify({
					slug: "denied",
					title: "Denied",
					definitions: [{authorId: "k", authorName: "kampus", body: "x"}],
				}),
			}),
		);
		expect(res.status).toBe(403);
	});

	it("admin seeder is gated 403 when ENVIRONMENT is not development (prod fail-closed)", async () => {
		// Regression for finding #1: the worker derives `adminAllowed` from
		// `ENVIRONMENT === "development"`. A non-dev environment (e.g. a real
		// `ENVIRONMENT=production` deploy) must close the gate.
		expect(adminGateFor("production")).toBe(false);
		const res = await fetch(
			appLayerProd,
			new Request("https://test.local/api/admin/sozluk/upsert-term", {
				method: "POST",
				headers: {"content-type": "application/json"},
				body: JSON.stringify({
					slug: "prod",
					title: "Prod",
					definitions: [{authorId: "k", authorName: "kampus", body: "x"}],
				}),
			}),
		);
		expect(res.status).toBe(403);
	});

	it("POST /api/admin/sozluk/upsert-term populates D1 and re-resolves over fate", async () => {
		const seed = await fetch(
			appLayerAllowed,
			new Request("https://test.local/api/admin/sozluk/upsert-term", {
				method: "POST",
				headers: {"content-type": "application/json"},
				body: JSON.stringify({
					slug: "merhaba",
					title: "Merhaba",
					definitions: [{authorId: "kampus", authorName: "kampus", body: "selam", score: 0}],
				}),
			}),
		);
		expect(seed.status).toBe(200);
		const seedBody = (await seed.json()) as {
			slug: string;
			created: boolean;
			insertedDefinitions: number;
		};
		expect(seedBody.slug).toBe("merhaba");
		expect(seedBody.created).toBe(true);
		expect(seedBody.insertedDefinitions).toBe(1);

		// Re-resolve the seeded term over the fate data plane (POST /fate).
		const fateRes = await fetch(
			appLayerAllowed,
			new Request("https://test.local/fate", {
				method: "POST",
				headers: {"content-type": "application/json"},
				body: JSON.stringify({
					version: 1,
					operations: [
						{
							id: "1",
							kind: "query",
							name: "term",
							args: {slug: "merhaba"},
							select: ["slug", "title", "count"],
						},
					],
				}),
			}),
		);
		expect(fateRes.status).toBe(200);
		const fateBody = (await fateRes.json()) as {
			results: Array<{ok: boolean; data: {slug: string; title: string; count: number} | null}>;
		};
		const result = fateBody.results[0]!;
		expect(result.ok).toBe(true);
		expect(result.data?.slug).toBe("merhaba");
		expect(result.data?.title).toBe("Merhaba");
		expect(result.data?.count).toBe(1);
	});

	it("/api/auth/* signs up a user and an authenticated fate request succeeds", async () => {
		const signUp = await fetch(
			appLayerAllowed,
			new Request("https://test.local/api/auth/sign-up/email", {
				method: "POST",
				headers: {"content-type": "application/json"},
				body: JSON.stringify({
					email: "writer@example.com",
					password: "hunter2hunter2",
					name: "writer",
				}),
			}),
		);
		expect([200, 201]).toContain(signUp.status);

		// Capture the session cookie better-auth set on sign-up.
		const setCookie = signUp.headers.get("set-cookie");
		expect(setCookie).toBeTruthy();
		const cookie = setCookie!.split(";")[0]!;

		// An authenticated fate `me` request carries the session cookie and
		// resolves the signed-up user end-to-end.
		const meRes = await fetch(
			appLayerAllowed,
			new Request("https://test.local/fate", {
				method: "POST",
				headers: {"content-type": "application/json", cookie},
				body: JSON.stringify({
					version: 1,
					operations: [{id: "1", kind: "query", name: "me", select: ["id", "username"]}],
				}),
			}),
		);
		expect(meRes.status).toBe(200);
		const meBody = (await meRes.json()) as {
			results: Array<{ok: boolean; data: {id: string} | null; error?: {code: string}}>;
		};
		const me = meBody.results[0]!;
		expect(me.ok).toBe(true);
		expect(me.data).not.toBeNull();
	});

	it("GET /fate/live is wired into AppLive and rejects 401 without a session", async () => {
		// The live SSE transport route forwards to the ConnectionDO (ADR 0028); here
		// we assert it is mounted in the compiled router and gated on a session
		// cookie before any DO is reached (the cross-DO behavior is proven in
		// `features/fate-live/do.test.ts`). No cookie → 401 fate error envelope.
		const res = await fetch(
			appLayerAllowed,
			new Request("https://test.local/fate/live?connectionId=anon"),
		);
		expect(res.status).toBe(401);
		const body = (await res.json()) as {results: Array<{error: {code: string}}>};
		expect(body.results[0]!.error.code).toBe("UNAUTHORIZED");
	});

	it("POST /fate/live with a session drives the connection subscribe RPC", async () => {
		// Sign up to get a session cookie, then a control POST reaches the
		// LiveConnections RPC seam (the no-op layer returns ok). Proves the route is
		// mounted and session-gated for the control path too.
		const signUp = await fetch(
			appLayerAllowed,
			new Request("https://test.local/api/auth/sign-up/email", {
				method: "POST",
				headers: {"content-type": "application/json"},
				body: JSON.stringify({
					email: "live@example.com",
					password: "hunter2hunter2",
					name: "live",
				}),
			}),
		);
		const cookie = signUp.headers.get("set-cookie")!.split(";")[0]!;
		const res = await fetch(
			appLayerAllowed,
			new Request("https://test.local/fate/live", {
				method: "POST",
				headers: {"content-type": "application/json", cookie},
				body: JSON.stringify({
					version: 1,
					connectionId: "c-1",
					operations: [
						{id: "op", kind: "subscribe", type: "Post", entityId: "p", select: ["score"]},
					],
				}),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {results: Array<{id: string; ok: boolean}>; version: number};
		expect(body.version).toBe(1);
		expect(body.results[0]).toMatchObject({id: "op", ok: true});
	});
});
