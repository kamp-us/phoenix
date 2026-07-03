/**
 * The ONE cold-start readiness primitive every per-PR-preview probe rides (ADR 0127).
 *
 * The per-file-stage integration model stands up ~24 brand-new `*.workers.dev` hostnames +
 * their DOs per run, so any probe's FIRST request can hit a cold Cloudflare edge / cold worker
 * before the route (or the DO, or the D1 read replica) has propagated. That window surfaces as
 * an HTML edge-placeholder-404, a 503 cold-start envelope, or a transient non-200 — none of them
 * a real failure. Three point-fixes each re-taught one probe to tolerate that window (#1689 the
 * `/fate/live` open, #1717 `h.signUp`, and the `/api/health` warm), drifting into parallel copies
 * of the same idea. This module is the durable shape those point-fixes fold into: ONE typed
 * placeholder-404 signal + ONE bounded readiness poll, parameterized by a per-probe `ready`
 * predicate — so every caller tolerates the cold window uniformly while still fast-failing on a
 * real error (only the placeholder-404 / not-ready signal rides the budget; every other throw
 * escapes at once). See ADR 0127 and `.patterns/alchemy-test-harness.md`.
 */

// Cloudflare serves an HTML placeholder 404 (an `<h1>` reading "There is nothing here yet",
// with the Cloudflare branding rendered as an inline SVG logo — the literal string "Powered by
// Cloudflare" is NOT in the body) from an edge PoP that has NOT yet propagated a freshly deployed
// `*.workers.dev` route. Any probe's FIRST request can draw a cold edge and get this page (#575).
// It is a propagation transient, not a real application 404 — the worker's own 404s are structured
// JSON (`{ok:false,error:{code}}`), never this HTML — so it is bounded-retryable where a genuine
// 404 is not.
export const isCloudflarePlaceholder404 = (status: number, body: string): boolean =>
	status === 404 &&
	(body.includes("There is nothing here yet") || body.startsWith("<!DOCTYPE html>"));

// The edge-placeholder-404 raised as a DISTINCT TYPE rather than a string-matched message. The
// readiness poll rides ONLY this out on its generous budget — every OTHER throw (an abort/timeout,
// a connection error, a real failure) still surfaces at once. Keeping it a type (not a message
// match) is what scopes the widened budget precisely to the edge-not-propagated transient, so a
// real failure can never be swallowed into the wait (#1689).
export class CloudflarePlaceholder404Error extends Error {
	constructor(path: string) {
		super(`cloudflare placeholder 404 at ${path} (edge not propagated)`);
		this.name = "CloudflarePlaceholder404Error";
	}
}

export const isCloudflarePlaceholder404Error = (e: unknown): e is CloudflarePlaceholder404Error =>
	e instanceof CloudflarePlaceholder404Error;

// The generous cold-start budget the readiness poll defaults to. A cold dedicated stage's first
// open can take many seconds to clear edge propagation + a cold DO / cold D1 replica; ~60s of
// polls is generous enough to ride that out, and only delays — never hangs (the poll returns the
// last response on deadline). Callers that want the deploy-probe cadence pass `pollMs: 2000`.
export const EDGE_READY_DEADLINE_MS = 60_000;
export const EDGE_READY_POLL_MS = 1_500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One `fetch` that converts the Cloudflare edge-placeholder-404 into the typed
 * `CloudflarePlaceholder404Error` the readiness poll rides out — the standalone counterpart of the
 * harness `req` loop's inline placeholder detection, for the deploy-time warm probes that fetch a
 * bare `url` before the harness client exists. On a 404 it peeks a clone's body (only on a 404, so
 * the hot path is untouched) and throws the typed error if it is the placeholder; every other
 * response is returned as-is for the caller's `ready` predicate to classify. A real worker JSON 404
 * never matches, so it is returned unretried.
 */
export const edgeFetch = async (input: string, init?: RequestInit): Promise<Response> => {
	const res = await fetch(input, init);
	if (res.status === 404) {
		const peek = await res.clone().text();
		if (isCloudflarePlaceholder404(res.status, peek)) {
			throw new CloudflarePlaceholder404Error(input);
		}
	}
	return res;
};

/**
 * The shared bounded readiness poll: re-send `send()` until `ready(res)` holds or the deadline
 * lapses. It rides out BOTH cold-edge not-ready shapes on the SAME budget — a not-ready RESPONSE
 * (`!ready(res)`, e.g. a 503 cold-start envelope or a non-200 that hasn't ripened) AND a THROWN
 * `CloudflarePlaceholder404Error` (the edge route not yet propagated). The placeholder tolerance is
 * SCOPED, not blanket: ONLY that typed error is caught-and-retried; every OTHER throw (an
 * abort/timeout, a connection error, a genuine failure) escapes immediately, unretried — so the
 * widened budget can never swallow a real failure. On a RESPONSE exhausting the deadline it returns
 * the last response, so the caller's own assertion still reports the truth (it never classifies a
 * status as terminal and stops early — the #1060 no-early-stop guarantee); on the deadline lapsing
 * while STILL on the placeholder-404 it re-throws that typed error so the edge-not-propagated
 * diagnostic surfaces rather than a synthetic status.
 *
 * `ready` may be async (e.g. the `/api/health` probe inspecting the JSON body), and is evaluated
 * against a clone-safe response — a not-ready response's body is released before the next poll so a
 * held SSE stream can't pin the fetch connection across the loop. Deadline/poll are parameters
 * (defaulting to the module bounds) so unit tests drive the logic on a tiny budget.
 */
export const awaitEdgeReady = async (
	send: () => Promise<Response>,
	ready: (res: Response) => boolean | Promise<boolean>,
	{
		deadlineMs = EDGE_READY_DEADLINE_MS,
		pollMs = EDGE_READY_POLL_MS,
	}: {deadlineMs?: number; pollMs?: number} = {},
): Promise<Response> => {
	const deadline = Date.now() + deadlineMs;
	// Map ONLY the typed placeholder-404 throw to a retryable value; any other throw propagates.
	const step = async (): Promise<Response | CloudflarePlaceholder404Error> => {
		try {
			return await send();
		} catch (e) {
			if (isCloudflarePlaceholder404Error(e)) return e;
			throw e;
		}
	};
	let last = await step();
	while (
		(last instanceof CloudflarePlaceholder404Error || !(await ready(last))) &&
		Date.now() < deadline
	) {
		if (!(last instanceof CloudflarePlaceholder404Error)) await last.body?.cancel().catch(() => {});
		await sleep(pollMs);
		last = await step();
	}
	if (last instanceof CloudflarePlaceholder404Error) throw last;
	return last;
};
