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

import {afterEach, describe, expect, it, vi} from "vitest";
import {
	awaitEdgeReady,
	CloudflarePlaceholder404Error,
	edgeFetch,
	isCloudflarePlaceholder404,
	isCloudflarePlaceholder404Error,
} from "./_edge-ready.ts";
import {isLiveWarmupNotReady} from "./_fate-live-warmup.ts";
import {harness} from "./_harness.ts";

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
		const healthReady = async (res: Response): Promise<boolean> => {
			if (res.status !== 200) return false;
			try {
				const body = (await res.clone().json()) as {status?: unknown} | null;
				return body?.status === "ok";
			} catch {
				return false;
			}
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
