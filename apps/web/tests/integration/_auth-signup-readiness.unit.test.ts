/**
 * Pins the harness `signUp` helper's cold-per-PR-preview-edge tolerance (#1717) — the
 * auth-signup sibling of the `/fate/live` gap #1689 closed. `h.signUp` mints every test
 * user via `POST /api/auth/sign-up/email`; on a cold edge that route serves the Cloudflare
 * placeholder-404 until it propagates, which `req` surfaces as a thrown typed
 * `CloudflarePlaceholder404Error`. `signUp` now rides that out on the same `pollUntilReady`
 * budget #1689 introduced (via `postAuthReady`), so a not-yet-propagated edge no longer fails
 * suite setup — while a REAL auth answer (the 422 already-exists → sign-in fallback, any genuine
 * 4xx) still returns AT ONCE, never swallowed into the readiness budget.
 *
 * Two tiers of coverage: end-to-end `signUp` over a stubbed `fetch` (the fast cold-edge-clears,
 * 422-fallback, and fail-fast-4xx paths through the real helper), plus the readiness composition
 * `pollUntilReady(send, () => true)` `signUp` wires — the mechanism-level pin for a placeholder
 * that persists past `req`'s own short window (the exact gap `postAuthReady` closes), which would
 * be slow to reproduce end-to-end but is exactly what #1689's `pollUntilReady` already guarantees.
 */

import {afterEach, describe, expect, it, vi} from "vitest";
import {CloudflarePlaceholder404Error, harness, pollUntilReady} from "./_harness.ts";

const buildHarness = () =>
	harness(
		() => "https://stage.example.workers.dev",
		() => ({accountId: "acct", databaseId: "db"}),
	);

// The Cloudflare edge-placeholder-404 body `req` classifies as "route not propagated yet".
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

afterEach(() => vi.unstubAllGlobals());

describe("h.signUp — cold-edge readiness end-to-end (#1717)", () => {
	it("rides out a cold-edge placeholder-404 that clears, then resolves the session", async () => {
		const fetchMock = stubFetch([placeholder404, () => authOk("u_1")]);
		const h = buildHarness();

		const session = await h.signUp("a@test.local", "password-password", "a");

		expect(session.userId).toBe("u_1");
		expect(session.cookie).toContain("better-auth.session=abc");
		// The placeholder-404 was retried (req's own loop), then the 200 served.
		expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("preserves the 422 USER_ALREADY_EXISTS → sign-in fallback (a real auth answer, handled at once)", async () => {
		const fetchMock = stubFetch([alreadyExists422, () => authOk("u_existing")]);
		const h = buildHarness();

		const session = await h.signUp("dup@test.local", "password-password", "dup");

		expect(session.userId).toBe("u_existing");
		// Exactly two calls: the 422 sign-up + the sign-in fallback — the 422 was NOT retried
		// into the readiness budget (a real worker answer returns immediately under `() => true`).
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("fails fast on a genuine 4xx — never retried into the readiness budget", async () => {
		const fetchMock = stubFetch([badRequest400]);
		const h = buildHarness();

		await expect(h.signUp("bad@test.local", "password-password", "bad")).rejects.toThrow(
			/sign-up failed: 400/,
		);
		// One call: a real 400 is a ready response, returned at once and surfaced as the throw —
		// not a placeholder, so `postAuthReady` never re-polls it.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("postAuthReady composition — pollUntilReady(send, () => true) (#1717)", () => {
	const BUDGET = {deadlineMs: 120, pollMs: 5} as const;
	const anyResponseReady = () => true;

	it("rides out a thrown placeholder-404 that PERSISTS past req's window, then resolves the real response", async () => {
		let call = 0;
		const send = vi.fn(async () => {
			call += 1;
			// `req` throws the typed placeholder error while the edge is still un-propagated.
			if (call <= 2) throw new CloudflarePlaceholder404Error("/api/auth/sign-up/email");
			return new Response("{}", {status: 200});
		});

		const res = await pollUntilReady(send, anyResponseReady, BUDGET);

		expect(res.status).toBe(200);
		expect(send).toHaveBeenCalledTimes(3);
	});

	it("returns a genuine 4xx AT ONCE — `() => true` means a real worker answer never re-polls", async () => {
		const send = vi.fn(async () => new Response("{}", {status: 400}));

		const res = await pollUntilReady(send, anyResponseReady, BUDGET);

		expect(res.status).toBe(400);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("a non-placeholder throw (an abort/timeout) propagates immediately, unretried", async () => {
		const abort = Object.assign(new Error("aborted"), {name: "AbortError"});
		const send = vi.fn(async () => {
			throw abort;
		});

		await expect(pollUntilReady(send, anyResponseReady, BUDGET)).rejects.toBe(abort);
		expect(send).toHaveBeenCalledTimes(1);
	});
});
