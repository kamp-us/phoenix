/**
 * HTTP surface on `HttpRouter` + `HttpApiBuilder`, Hono-free (ADR 0027).
 *
 * Drives the *compiled* app — `HttpRouter.toHttpEffect(makeAppLive(...))`, the
 * exact effect the worker returns as `fetch` — over a `node:sqlite`-backed D1,
 * providing the worker-level services exactly as the alchemy runtime does, then
 * asserting on the `Response`. Runs in the node pool (the alchemy worker can't
 * load into `@cloudflare/vitest-pool-workers` yet).
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
import {makeSqliteTestDb, type SqliteD1} from "../db/sqlite-d1.testing.ts";
import {makeFateRuntime, PhoenixFateLive} from "../features/fate/layers.ts";
import {LiveConnections, LiveTopics} from "../features/fate-live/topics.ts";
import {Flagship} from "../features/flagship/Flagship.ts";
import {layerTest, makeRealAuthForTest} from "../features/pasaport/better-auth.testing.ts";
import {makeAppLive} from "./app.ts";

/**
 * A no-op live layer — these cases exercise health / auth / fate, not the live
 * SSE path (that has its own `features/fate-live/do.test.ts`).
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
let appLayer: ReturnType<typeof makeAppLive>;

const ENV = {
	ENVIRONMENT: "development",
	BETTER_AUTH_URL: "http://localhost:3000",
	BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3000",
	BETTER_AUTH_SECRET: "phoenix-test-secret",
} as const;

const EXEC_CTX = {waitUntil: () => {}, passThroughOnException: () => {}};

/**
 * Drive one request through the compiled app. Everything runs inside one `Scope`
 * so the built layer stays alive for the inner effect.
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
		// Mirror the `ConfigProvider` alchemy auto-wires from the bound env, so the
		// health handler's `yield* AppConfig` read resolves from the same `ENV`.
		Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(ENV)),
		Effect.scoped,
	);
	return Effect.runPromise(program as Effect.Effect<Response>);
}

beforeAll(() => {
	sqlite = makeSqliteTestDb();

	// ONE database for the whole test (ADR 0040): a single `node:sqlite` handle
	// behind the `Database` seam, shared by `makeFateLayer`'s `Drizzle` and the
	// better-auth adapter below — the old dual-drizzle accident is gone.
	const databaseLayer = Layer.succeed(Database)(sqlite.d1);

	// A real better-auth instance over the SAME D1 via `makeRealAuthForTest`,
	// which mirrors the deployed `BetterAuthLive` directly (its Layer needs the
	// full alchemy provider stack — `RuntimeContext`, the `secret_text` binding —
	// which doesn't exist in the node test runtime).
	const testAuthInstance = makeRealAuthForTest(sqlite.d1);

	// Widen the concrete `Auth<…>` to the generic `Auth` `layerTest` takes; the
	// two don't statically overlap (TS2345), so the widen needs the `unknown` hop.
	// biome-ignore lint/plugin: concrete `Auth<…>` vs the generic `Auth` don't overlap (TS2345), so this widen needs the hop.
	const widenedAuth = testAuthInstance as unknown as Parameters<typeof layerTest>[0];
	const betterAuthLayer = layerTest(widenedAuth);

	// Build the route-context layer through the same `makeFateRuntime` the
	// deployed worker uses, keeping the shared memoMap + never-dispose decision
	// identical to production (ADR 0040/0041; runtime is init-only wiring since the
	// v2 cutover, ADR 0043).
	const {contextLayer: fateLayer} = makeFateRuntime(
		PhoenixFateLive.pipe(Layer.provide(Layer.merge(databaseLayer, betterAuthLayer))),
	);

	// A minimal `BaseRuntimeContext` stub — these cases never reach the
	// `/api/auth/*` route's RuntimeContext-consuming secret resolution, so a no-op
	// store satisfying the structural type suffices.
	const runtimeContext: BaseRuntimeContext = {
		Type: "test",
		id: "test",
		env: {},
		get: () => Effect.succeed(undefined),
		set: (id) => Effect.succeed(id),
	};

	// A minimal `Flagship` client fake: the health route only reads one boolean,
	// so unread methods die. `getBooleanValue` returns the default — the same
	// fall-back the real binding gives for an undeclared flag — with `R = never`,
	// so the test path needs no `RuntimeContext` for the typed-JSON group.
	const flagshipLayer = Layer.succeed(Flagship)(
		Flagship.of({
			raw: Effect.die("Flagship.raw not exercised in app.test"),
			get: () => Effect.die("Flagship.get not exercised in app.test"),
			getBooleanValue: (_key, defaultValue) => Effect.succeed(defaultValue),
			getStringValue: (_key, defaultValue) => Effect.succeed(defaultValue),
			getNumberValue: (_key, defaultValue) => Effect.succeed(defaultValue),
			getObjectValue: (_key, defaultValue) => Effect.succeed(defaultValue),
			getBooleanDetails: () => Effect.die("Flagship.getBooleanDetails not exercised in app.test"),
			getStringDetails: () => Effect.die("Flagship.getStringDetails not exercised in app.test"),
			getNumberDetails: () => Effect.die("Flagship.getNumberDetails not exercised in app.test"),
			getObjectDetails: () => Effect.die("Flagship.getObjectDetails not exercised in app.test"),
		}),
	);

	appLayer = makeAppLive({
		fateLayer,
		liveLayer,
		betterAuthLayer,
		flagshipLayer,
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
		const body = (await res.json()) as {
			status: string;
			environment: string | null;
			flagshipBound: boolean;
		};
		expect(body.status).toBe("ok");
		expect(body.environment).toBe("development");
		// the boolean read through the Flagship binding surfaced (default fallback)
		expect(body.flagshipBound).toBe(false);
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

		const setCookie = signUp.headers.get("set-cookie");
		expect(setCookie).toBeTruthy();
		const cookie = setCookie!.split(";")[0]!;

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

	it("GET /rss.xml → 200 application/rss+xml, well-formed RSS 2.0", async () => {
		const res = await fetch(appLayer, new Request("https://test.local/rss.xml"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/application\/rss\+xml/);
		const body = await res.text();
		expect(body).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
		expect(body).toContain('<rss version="2.0"');
		expect(body).toContain("<channel>");
		expect(body).toContain("</channel></rss>");
		// the atom self-link points back at the feed's own absolute URL (request origin)
		expect(body).toContain('<atom:link href="https://test.local/rss.xml" rel="self"');
	});

	it("GET /rss.xml lists a submitted post with an absolute link + pubDate", async () => {
		const signUp = await fetch(
			appLayer,
			new Request("https://test.local/api/auth/sign-up/email", {
				method: "POST",
				headers: {"content-type": "application/json"},
				body: JSON.stringify({
					email: "rss@example.com",
					password: "hunter2hunter2",
					name: "rss",
				}),
			}),
		);
		const cookie = signUp.headers.get("set-cookie")!.split(";")[0]!;

		const submit = await fetch(
			appLayer,
			new Request("https://test.local/fate", {
				method: "POST",
				headers: {"content-type": "application/json", cookie},
				body: JSON.stringify({
					version: 1,
					operations: [
						{
							id: "1",
							kind: "mutation",
							name: "post.submit",
							input: {title: "rss feed test post", tags: [{kind: "meta"}]},
							select: ["id"],
						},
					],
				}),
			}),
		);
		expect(submit.status).toBe(200);

		const res = await fetch(appLayer, new Request("https://test.local/rss.xml"));
		const body = await res.text();
		expect(body).toContain("<title>rss feed test post</title>");
		expect(body).toMatch(/<link>https:\/\/test\.local\/pano\/[^<]+<\/link>/);
		expect(body).toMatch(/<pubDate>[^<]+GMT<\/pubDate>/);
	});

	it("GET /fate/live is wired into AppLive and rejects 401 without a session", async () => {
		// Asserts the route is mounted in the compiled router and session-gated
		// before any DO is reached (cross-role behavior: `features/fate-live/do.test.ts`).
		const res = await fetch(
			appLayer,
			new Request("https://test.local/fate/live?connectionId=anon"),
		);
		expect(res.status).toBe(401);
		const body = (await res.json()) as {results: Array<{error: {code: string}}>};
		expect(body.results[0]!.error.code).toBe("UNAUTHORIZED");
	});

	it("POST /fate/live with a session drives the connection subscribe RPC", async () => {
		// A session-bearing control POST reaches the LiveConnections RPC seam (the
		// no-op layer returns ok) — proves the control path is mounted and gated too.
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
