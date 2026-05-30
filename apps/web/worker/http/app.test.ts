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
 * Covers the acceptance criteria end-to-end through the real router:
 *   - `GET /api/health` is an `HttpApiBuilder` group → 200 JSON.
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
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {createDrizzle} from "../db/Drizzle.ts";
import baselineMigration from "../db/drizzle/migrations/0000_d1_baseline.sql?raw";
import * as schema from "../db/drizzle/schema.ts";
import {makeSqliteD1, type SqliteD1} from "../features/fate/__support__/sqlite-d1.ts";
import {makeFateLayer} from "../features/fate/layers.ts";
import {LiveConnections, LiveTopics} from "../features/fate-live/topics.ts";
import {makeAppLive} from "./app.ts";

/**
 * A no-op live layer for the HTTP-surface tests — these cases exercise health /
 * auth / fate, not the live SSE path (the live fan-out has its own
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

let sqlite: SqliteD1;
/** The compiled `AppLive` driven by every case. */
let appLayer: ReturnType<typeof makeAppLive>;

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
async function fetch(
	appLayer: ReturnType<typeof makeAppLive>,
	request: Request,
): Promise<Response> {
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
		// The health handler reads `ENVIRONMENT` via `yield* AppConfig` off the
		// `ConfigProvider` the alchemy runtime auto-wires from the bound env
		// (`ConfigProvider.fromUnknown(env)`, `WorkerBridge`). Mirror that here so
		// the read resolves `development` from the same `ENV` snapshot.
		Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(ENV)),
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
	// the deployed worker also satisfies). The concrete and generic `Auth` types
	// don't statically overlap (TS2352), so the widen needs the `unknown` hop.
	const fateLayer = makeFateLayer(
		db,
		// biome-ignore lint/plugin: see above — concrete `Auth<…>` vs the generic `Auth` re-export don't overlap (TS2352), so this widen needs the hop.
		testAuthInstance as unknown as Parameters<typeof makeFateLayer>[1],
	);

	appLayer = makeAppLive({
		fateLayer,
		liveLayer,
		betterAuthLayer,
	});
});

afterAll(() => {
	sqlite?.close();
});

describe("HTTP surface — HttpApiBuilder + HttpRouter (Hono-free)", () => {
	it("GET /api/health → 200 JSON", async () => {
		const res = await fetch(appLayer, new Request("https://test.local/api/health"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {status: string; environment: string | null};
		expect(body.status).toBe("ok");
		expect(body.environment).toBe("development");
	});

	it("/api/auth/* signs up a user and an authenticated fate request succeeds", async () => {
		const signUp = await fetch(
			appLayer,
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
			appLayer,
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
			appLayer,
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
			appLayer,
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
			appLayer,
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
