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
import type {BaseRuntimeContext} from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import {Effect} from "effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {Database} from "../db/Database.ts";
import {makeSqliteTestDb, type SqliteD1} from "../db/sqlite-d1.fake.ts";
import {makeFateLayer} from "../features/fate/layers.ts";
import {LiveConnections, LiveTopics} from "../features/fate-live/topics.ts";
import {
	makeBetterAuthTestLayer,
	makeRealAuthForTest,
} from "../features/pasaport/better-auth.fake.ts";
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
	sqlite = makeSqliteTestDb();

	// ONE database for the whole test (ADR 0040 b1): a single `node:sqlite` handle
	// behind the `Database` seam. `makeFateLayer`'s `Drizzle` and the better-auth
	// adapter below both run on this handle — the old dual-drizzle accident (a
	// separate `createDrizzle(...)` threaded into `makeFateLayer` alongside
	// better-auth's own drizzle) is gone.
	const databaseLayer = Layer.succeed(Database)(sqlite.d1);

	// Build a real better-auth instance over the SAME `node:sqlite`-backed D1 via
	// the shared `makeRealAuthForTest` helper (colocated with `better-auth.fake.ts`),
	// which mirrors the deployed `BetterAuthLive`
	// (`worker/features/pasaport/better-auth-live.ts`). That Layer needs the full
	// alchemy provider stack (`RuntimeContext`, the `secret_text` binding) which
	// doesn't exist in the node test runtime; the helper reproduces the same
	// construction directly. Provided through a hand-rolled Layer over the same
	// `BetterAuth` Context tag (`makeBetterAuthTestLayer`), it is the test-mode
	// equivalent. The helper's `drizzle(d1, ...)` is better-auth's own internal
	// builder over the same handle — not a second feature `Drizzle`.
	const testAuthInstance = makeRealAuthForTest(sqlite.d1);

	// `makeBetterAuth(...)` returns `Auth<{...specific options}>`; widen to the
	// generic `Auth` `makeBetterAuthTestLayer` takes (the same type the deployed
	// worker satisfies). The concrete and generic `Auth` types don't statically
	// overlap (TS2345), so the widen needs the `unknown` hop.
	// biome-ignore lint/plugin: concrete `Auth<…>` vs the generic `Auth` don't overlap (TS2345), so this widen needs the hop.
	const widenedAuth = testAuthInstance as unknown as Parameters<typeof makeBetterAuthTestLayer>[0];
	const betterAuthLayer = makeBetterAuthTestLayer(widenedAuth);

	// `makeFateLayer` is a zero-arg layer with `R = Database | BetterAuth`
	// (ADR 0040 b1); the two seams are discharged inside `makeAppLive`'s request
	// layer from `databaseLayer` + `betterAuthLayer`.
	const fateLayer = makeFateLayer;

	// A minimal `BaseRuntimeContext` stub. The HTTP-surface cases here never reach
	// the `/api/auth/*` route's RuntimeContext-consuming secret resolution (sign-up
	// runs against the hand-rolled test better-auth instance above), so a no-op
	// key/value store satisfying the structural type is sufficient — no cast needed.
	const runtimeContext: BaseRuntimeContext = {
		Type: "test",
		id: "test",
		env: {},
		get: () => Effect.succeed(undefined),
		set: (id) => Effect.succeed(id),
	};

	appLayer = makeAppLive({
		fateLayer,
		databaseLayer,
		liveLayer,
		betterAuthLayer,
		runtimeContext,
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
		// The live SSE transport route forwards to the unified `LiveDO` in its
		// connection role (`LiveConnections`, ADR 0037); here we assert it is mounted
		// in the compiled router and gated on a session cookie before any DO is
		// reached (the cross-role behavior is proven in
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
