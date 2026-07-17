/**
 * Pins the ONE shared cold-start readiness primitive (`awaitEdgeReady`, ADR 0127) — the durable
 * shape the #1689 (`/fate/live`) and #1717 (`h.signUp`) point-fixes fold into, covering all three
 * probes' load-bearing invariants:
 *
 *   1. A CF edge-placeholder-404 / cold-worker signal rides the bounded budget (retry until it
 *      propagates or the deadline lapses) — for every probe, via ONE typed throw.
 *   2. A real error fast-fails: an abort, a genuine 4xx, a terminal worker JSON 4xx, and the
 *      422-already-exists answer surface at once, never swallowed into the budget.
 *   3. The three probes' `ready` predicates are exercised over the shared primitive: the SSE-open
 *      shape (200 + `text/event-stream`), the signup shape (`() => true`, only a thrown placeholder
 *      retries), the `/api/health` shape (async body inspection), and the `/fate/live`-warm shape
 *      (a terminal worker JSON 4xx stops the poll).
 *
 * This replaces the two per-probe point-fix test files (`_fate-live-readiness.unit.test.ts` #1690,
 * `_auth-signup-readiness.unit.test.ts` #1720) now that their logic is one primitive.
 */

import * as Effect from "effect/Effect";
import {afterEach, describe, expect, it, vi} from "vitest";
import {
	awaitEdgeReady,
	CloudflarePlaceholder404Error,
	edgeFetch,
	isCloudflarePlaceholder404,
	isCloudflarePlaceholder404Error,
	WorkerNotReadyError,
} from "./_edge-ready.ts";
import {isLiveWarmupNotReady} from "./_fate-live-warmup.ts";
import {harness} from "./_harness.ts";
import {awaitAuthRouteReady, awaitWorkerReady} from "./_integration.ts";

// A tiny budget so the tests drive the readiness logic in milliseconds, not the real 60s.
const BUDGET = {deadlineMs: 120, pollMs: 5} as const;

const okStream = () =>
	new Response("", {status: 200, headers: {"content-type": "text/event-stream"}});
// The `/fate/live` SSE-open readiness predicate (200 + event-stream), used across the poll tests.
const sseReady = (res: Response): boolean =>
	res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/event-stream");

describe("awaitEdgeReady — the shared cold-start readiness primitive (ADR 0127)", () => {
	it("rides out a placeholder-404 that CLEARS within the budget → resolves the 200 (not thrown at ~5s)", async () => {
		let call = 0;
		const send = vi.fn(async () => {
			call += 1;
			// The edge is not propagated for the first two opens (the throw `req`/`edgeFetch` raises), then serves.
			if (call <= 2) throw new CloudflarePlaceholder404Error("/fate/live");
			return okStream();
		});

		const res = await awaitEdgeReady(send, sseReady, BUDGET);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		expect(send).toHaveBeenCalledTimes(3);
	});

	it("a placeholder-404 that NEVER clears → keeps retrying to the DEADLINE, then throws the typed error (rides the full budget, not the ~5s req window)", async () => {
		const send = vi.fn(async () => {
			throw new CloudflarePlaceholder404Error("/fate/live");
		});

		const start = Date.now();
		await expect(awaitEdgeReady(send, sseReady, BUDGET)).rejects.toBeInstanceOf(
			CloudflarePlaceholder404Error,
		);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeGreaterThanOrEqual(BUDGET.deadlineMs);
		expect(send.mock.calls.length).toBeGreaterThan(1);
	});

	it("a NON-placeholder throw (an abort/timeout) is NOT swallowed — it propagates immediately, unretried (invariant 2)", async () => {
		const abort = Object.assign(new Error("The operation was aborted"), {name: "AbortError"});
		const send = vi.fn(async () => {
			throw abort;
		});

		await expect(awaitEdgeReady(send, sseReady, BUDGET)).rejects.toBe(abort);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("a not-ready RESPONSE (a 503 cold-start envelope) rides the budget and returns the last response on deadline (the #1060 no-early-stop guarantee)", async () => {
		const send = vi.fn(async () => new Response("", {status: 503}));

		const res = await awaitEdgeReady(send, sseReady, BUDGET);

		expect(res.status).toBe(503);
		expect(send.mock.calls.length).toBeGreaterThan(1);
	});

	it("signup shape (`() => true`): a genuine 4xx returns AT ONCE — a real worker answer never re-polls (invariant 2)", async () => {
		const send = vi.fn(async () => new Response("{}", {status: 400}));

		const res = await awaitEdgeReady(send, () => true, BUDGET);

		expect(res.status).toBe(400);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("`/api/health` shape (ASYNC body predicate): rides a 200-but-not-`ok` body out, then resolves once the body reads `{status:'ok'}`", async () => {
		let call = 0;
		// Mirrors production `healthReady`: fold the `.json()` rejection to `null` (⇒ not ready)
		// rather than a raw try/catch in this effect-importing file (#2736 no-raw-try-catch).
		const healthReady = async (res: Response): Promise<boolean> => {
			if (res.status !== 200) return false;
			const body = (await res
				.clone()
				.json()
				.catch(() => null)) as {status?: unknown} | null;
			return body?.status === "ok";
		};
		const send = vi.fn(async () => {
			call += 1;
			// First two: propagating (a 503, then a 200 whose body isn't `ok` yet); then healthy.
			if (call === 1) return new Response("<html>edge</html>", {status: 503});
			if (call === 2) return new Response(JSON.stringify({status: "warming"}), {status: 200});
			return new Response(JSON.stringify({status: "ok"}), {status: 200});
		});

		const res = await awaitEdgeReady(send, healthReady, BUDGET);

		expect(await healthReady(res)).toBe(true);
		expect(send).toHaveBeenCalledTimes(3);
	});

	it("`/fate/live`-warm shape: a terminal worker JSON 4xx STOPS the poll (a real 404/auth answer isn't burned on the budget — invariant 2)", async () => {
		// warmLiveDO's predicate, mirrored exactly: ready on 200 OR a terminal worker JSON 4xx
		// (`!isLiveWarmupNotReady` — the real classifier the harness uses).
		const liveWarmReady = (res: Response): boolean =>
			res.status === 200 ||
			!isLiveWarmupNotReady(res.status, res.headers.get("content-type") ?? "");
		const send = vi.fn(
			async () =>
				new Response('{"ok":false,"error":{"code":"UNAUTHORIZED"}}', {
					status: 401,
					headers: {"content-type": "application/json"},
				}),
		);

		const res = await awaitEdgeReady(send, liveWarmReady, BUDGET);

		expect(res.status).toBe(401);
		// Fast-fail: the terminal worker JSON 4xx was ready on the FIRST attempt, never re-polled.
		expect(send).toHaveBeenCalledTimes(1);
	});
});

// The shared bootstrap gates the run-scoped stage on the AUTH-provisioning route being past the CF
// edge placeholder before releasing the URL — edge propagation is per-route, so `/api/health` can
// ripen while `/api/auth/sign-up/email` still 404s and reds all 53 forked suites (#2416). This pins
// that gate probes the auth route (POST) and rides ONLY the placeholder-404, not a real answer.
describe("awaitAuthRouteReady — the bootstrap auth-route propagation gate (#2416)", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("probes POST /api/auth/sign-up/email and resolves on the first real (non-placeholder) response", async () => {
		// Typed impl params so `mock.calls` infers `[string, RequestInit?]` — assert the probed
		// route + method off the recorded call without a type assertion.
		const fetchMock = vi.fn(
			async (_input: string, _init?: RequestInit) =>
				new Response(JSON.stringify({code: "INVALID_EMAIL"}), {status: 400}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await Effect.runPromise(awaitAuthRouteReady("https://stage.example.workers.dev"));

		// One call: a real worker 400 (the empty-body probe answer) is READY at once under
		// `() => true` — a genuine auth 4xx is never swallowed into the readiness budget (invariant 2).
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [input, init] = fetchMock.mock.calls[0]!;
		expect(input).toBe("https://stage.example.workers.dev/api/auth/sign-up/email");
		expect(init?.method).toBe("POST");
	});

	it("rides out a cold-edge placeholder-404 on the auth route until it propagates, then resolves", async () => {
		let call = 0;
		const fetchMock = vi.fn(async () => {
			call += 1;
			// The auth route is not propagated on the first open (CF HTML placeholder 404 → edgeFetch
			// throws the typed error the gate rides), then serves a structured 4xx (route propagated).
			if (call === 1)
				return new Response("<!DOCTYPE html>There is nothing here yet", {status: 404});
			return new Response(JSON.stringify({code: "INVALID_EMAIL"}), {status: 400});
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			Effect.runPromise(awaitAuthRouteReady("https://stage.example.workers.dev")),
		).resolves.toBeUndefined();
		expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
	});
});

// The DEPLOY-time worker-health gate turns a worker that never serves healthy JSON within its
// readiness budget into a TYPED, greppable `WorkerNotReadyError` — and, sized below the hook ceiling
// (`PER_FILE_HEALTH_DEADLINE_MS`), that throw fires before the vitest `beforeAll` guillotine so the
// eviction cause is a named diagnostic, not the opaque "Hook timed out in 120000ms" (#3146).
describe("awaitWorkerReady — typed readiness diagnostic (#3146)", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("WorkerNotReadyError carries the url + detail in a named, greppable message", () => {
		const e = new WorkerNotReadyError("https://stage.example.workers.dev", "last status 503");
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe("WorkerNotReadyError");
		expect(e._tag).toBe("WorkerNotReady");
		expect(e.message).toContain("https://stage.example.workers.dev");
		expect(e.message).toContain("last status 503");
	});

	it("a worker that never serves healthy JSON within the budget throws the typed diagnostic (not a bare Error, not a hook timeout)", async () => {
		// A 200 whose body is never `{status:"ok"}` rides the readiness budget and never goes ready;
		// on deadline `awaitEdgeReady` returns the last (still-not-ready) response, and the gate throws.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({status: "warming"}), {status: 200})),
		);
		// A tiny per-call budget drives the exhaustion in milliseconds, not the real 100s.
		await expect(
			Effect.runPromise(awaitWorkerReady("https://stage.example.workers.dev", 40)),
		).rejects.toThrow(/worker never served a healthy \/api\/health within the readiness window/);
	});
});

describe("isCloudflarePlaceholder404 — placeholder vs real-404 distinction (the throw-vs-return gate)", () => {
	it.each([
		["the CF placeholder page (edge not propagated)", 404, "There is nothing here yet"],
		["a bare CF HTML placeholder body", 404, "<!DOCTYPE html><html><body>...</body></html>"],
	])("treats %s as the retryable edge placeholder", (_label, status, body) => {
		expect(isCloudflarePlaceholder404(status, body)).toBe(true);
	});

	it.each([
		["a real worker JSON 404", 404, '{"ok":false,"error":{"code":"NOT_FOUND"}}'],
		["a JSON body on a non-404 status", 200, '{"ok":true}'],
		["an auth 401 JSON body under a 404-only detector", 401, '{"ok":false}'],
	])("does NOT treat %s as the edge placeholder", (_label, status, body) => {
		expect(isCloudflarePlaceholder404(status, body)).toBe(false);
	});
});

describe("isCloudflarePlaceholder404Error — the typed guard the poll rides ONLY", () => {
	it("recognizes the typed placeholder error", () => {
		expect(isCloudflarePlaceholder404Error(new CloudflarePlaceholder404Error("/fate/live"))).toBe(
			true,
		);
	});

	it.each([
		[
			"a generic Error",
			new Error("cloudflare placeholder 404 at /fate/live (edge not propagated)"),
		],
		["an abort-shaped error", Object.assign(new Error("aborted"), {name: "AbortError"})],
		["a non-error value", "cloudflare placeholder 404"],
		["null", null],
	])("does NOT recognize %s (so the poll won't ride it out)", (_label, value) => {
		expect(isCloudflarePlaceholder404Error(value)).toBe(false);
	});
});

describe("edgeFetch — the deploy-probe placeholder detector (throw-on-placeholder, return-real)", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("throws the typed CloudflarePlaceholder404Error on a CF HTML placeholder 404", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("<!DOCTYPE html>There is nothing here yet", {status: 404})),
		);
		await expect(edgeFetch("https://stage.example.workers.dev/api/health")).rejects.toBeInstanceOf(
			CloudflarePlaceholder404Error,
		);
	});

	it("RETURNS a real worker JSON 404 unretried (never mistaken for the placeholder)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response('{"ok":false,"error":{"code":"NOT_FOUND"}}', {status: 404})),
		);
		const res = await edgeFetch("https://stage.example.workers.dev/fate");
		expect(res.status).toBe(404);
	});

	it("RETURNS a 200 (and any non-404) as-is", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response('{"status":"ok"}', {status: 200})),
		);
		const res = await edgeFetch("https://stage.example.workers.dev/api/health");
		expect(res.status).toBe(200);
	});
});

// h.signUp mints every integration user (22 call sites) via `POST /api/auth/sign-up/email`;
// it now rides the shared `awaitEdgeReady` budget (via the harness `postAuthReady`), so a cold
// edge no longer fails suite setup — while a REAL auth answer still returns at once.
describe("h.signUp — cold-edge readiness over the shared primitive (invariants 1 + 2)", () => {
	afterEach(() => vi.unstubAllGlobals());

	const buildHarness = () =>
		harness(
			() => "https://stage.example.workers.dev",
			() => ({accountId: "acct", databaseId: "db"}),
		);

	const placeholder404 = (): Response =>
		new Response("<!DOCTYPE html><html><body>There is nothing here yet</body></html>", {
			status: 404,
			headers: {"content-type": "text/html"},
		});
	const authOk = (userId: string): Response =>
		new Response(JSON.stringify({user: {id: userId}}), {
			status: 200,
			headers: {
				"content-type": "application/json",
				"set-cookie": "better-auth.session=abc; Path=/; HttpOnly",
			},
		});
	const alreadyExists422 = (): Response =>
		new Response(JSON.stringify({code: "USER_ALREADY_EXISTS"}), {
			status: 422,
			headers: {"content-type": "application/json"},
		});
	const badRequest400 = (): Response =>
		new Response(JSON.stringify({code: "INVALID_EMAIL"}), {
			status: 400,
			headers: {"content-type": "application/json"},
		});

	// A queue-driven `fetch` stub: each call returns the next queued response, repeating the last
	// once the queue is drained (so an unexpected extra call is visible as the repeated tail).
	const stubFetch = (queue: Array<() => Response>) => {
		let i = 0;
		const fn = vi.fn(async () => {
			const make = queue[Math.min(i, queue.length - 1)]!;
			i += 1;
			return make();
		});
		vi.stubGlobal("fetch", fn);
		return fn;
	};

	it("rides out a cold-edge placeholder-404 that clears, then resolves the session (invariant 1)", async () => {
		const fetchMock = stubFetch([placeholder404, () => authOk("u_1")]);
		const h = buildHarness();

		const session = await h.signUp("a@test.local", "password-password", "a");

		expect(session.userId).toBe("u_1");
		expect(session.cookie).toContain("better-auth.session=abc");
		expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("preserves the 422 USER_ALREADY_EXISTS → sign-in fallback (a real auth answer, handled at once — invariant 2)", async () => {
		const fetchMock = stubFetch([alreadyExists422, () => authOk("u_existing")]);
		const h = buildHarness();

		const session = await h.signUp("dup@test.local", "password-password", "dup");

		expect(session.userId).toBe("u_existing");
		// Exactly two calls: the 422 sign-up + the sign-in fallback — the 422 was NOT retried
		// into the readiness budget (a real worker answer returns immediately under `() => true`).
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("fails fast on a genuine 4xx — never retried into the readiness budget (invariant 2)", async () => {
		const fetchMock = stubFetch([badRequest400]);
		const h = buildHarness();

		await expect(h.signUp("bad@test.local", "password-password", "bad")).rejects.toThrow(
			/sign-up failed: 400/,
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
