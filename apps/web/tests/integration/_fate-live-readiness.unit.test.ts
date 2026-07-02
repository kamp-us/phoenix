/**
 * Pins the harness readiness poll's cold-`/fate/live`-edge tolerance (#1689): the CF
 * edge-placeholder-404 (`req` throws a `CloudflarePlaceholder404Error` after its own short loop)
 * must ride the SAME generous `pollUntilReady` budget that already covers the 503 cold-start
 * envelope — and that widened tolerance must be SCOPED to the placeholder-404 alone. A real
 * failure (an abort/timeout, any non-placeholder throw) must still surface at once, and a real
 * application 404 (structured JSON) must never be mistaken for the edge placeholder.
 */

import {describe, expect, it, vi} from "vitest";
import {
	CloudflarePlaceholder404Error,
	isCloudflarePlaceholder404,
	isCloudflarePlaceholder404Error,
	pollUntilReady,
} from "./_harness.ts";

// A tiny budget so the test drives the readiness logic in milliseconds, not the real 60s.
const BUDGET = {deadlineMs: 120, pollMs: 5} as const;

const okStream = () =>
	new Response("", {status: 200, headers: {"content-type": "text/event-stream"}});
const isStreamReady = (res: Response): boolean =>
	res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/event-stream");

describe("pollUntilReady — cold /fate/live edge tolerance (#1689)", () => {
	it("rides out a placeholder-404 that CLEARS within the budget → resolves with the 200 stream (not thrown at ~5s)", async () => {
		let call = 0;
		const send = vi.fn(async () => {
			call += 1;
			// The edge is not propagated for the first two opens (the throw `req` raises), then serves.
			if (call <= 2) throw new CloudflarePlaceholder404Error("/fate/live");
			return okStream();
		});

		const res = await pollUntilReady(send, isStreamReady, BUDGET);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		expect(send).toHaveBeenCalledTimes(3);
	});

	it("a placeholder-404 that NEVER clears → keeps retrying to the DEADLINE, then throws the placeholder error (rides the full budget, not the ~5s req window)", async () => {
		const send = vi.fn(async () => {
			throw new CloudflarePlaceholder404Error("/fate/live");
		});

		const start = Date.now();
		await expect(pollUntilReady(send, isStreamReady, BUDGET)).rejects.toBeInstanceOf(
			CloudflarePlaceholder404Error,
		);
		const elapsed = Date.now() - start;

		// It rode the readiness budget rather than surfacing at the first (or ~5s-th) throw:
		// it polled repeatedly across ~deadlineMs before giving up.
		expect(elapsed).toBeGreaterThanOrEqual(BUDGET.deadlineMs);
		expect(send.mock.calls.length).toBeGreaterThan(1);
	});

	it("a NON-placeholder throw (an abort/timeout) is NOT swallowed — it propagates immediately, unretried", async () => {
		const abort = Object.assign(new Error("The operation was aborted"), {name: "AbortError"});
		const send = vi.fn(async () => {
			throw abort;
		});

		await expect(pollUntilReady(send, isStreamReady, BUDGET)).rejects.toBe(abort);
		// Fail-fast: the abort escaped on the very first attempt, never retried to the deadline.
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("a not-ready RESPONSE (e.g. a 503 cold-start envelope) still rides the budget and returns the last response on deadline (the #1060 no-early-stop guarantee is preserved)", async () => {
		const send = vi.fn(async () => new Response("", {status: 503}));

		const res = await pollUntilReady(send, isStreamReady, BUDGET);

		expect(res.status).toBe(503);
		expect(send.mock.calls.length).toBeGreaterThan(1);
	});
});

describe("isCloudflarePlaceholder404 — placeholder vs real-404 distinction (the throw-vs-return gate in `req`)", () => {
	it.each([
		["the CF placeholder page (edge not propagated)", 404, "There is nothing here yet"],
		["a bare CF HTML placeholder body", 404, "<!DOCTYPE html><html><body>...</body></html>"],
	])("treats %s as the retryable edge placeholder", (_label, status, body) => {
		expect(isCloudflarePlaceholder404(status, body)).toBe(true);
	});

	it.each([
		// A real worker 404 is structured JSON, never the HTML placeholder — `req` RETURNS it
		// (never throws the typed error), so it is NOT swallowed into the widened readiness budget.
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
