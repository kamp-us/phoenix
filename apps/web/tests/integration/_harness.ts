/**
 * Integration-test HTTP harness — the black-box client surface every integration
 * test drives (ADR 0026–0031, ADR 0082, `.patterns/alchemy-test-harness.md`).
 *
 * The harness owns no deploy lifecycle. `integrationStack()` (in `_integration.ts`)
 * deploys the real phoenix stack to **real remote Cloudflare** with a **per-file
 * isolated stage** (`Test.make` + `beforeAll(deploy(Stack, {stage}))` +
 * `afterAll.skipIf(...)(destroy(Stack, {stage}))` + retry-first-request) and hands
 * this factory a `getUrl` accessor resolving to that stage's deployed worker URL.
 * Tests assert **black-box over HTTP** against it. No `cloudflare:test`, no
 * `SELF.fetch`, no `env.PHOENIX_DB`, no `runInDurableObject`, no shared single
 * deploy.
 *
 * D1 is real remote Cloudflare D1, migrated by the existing
 * `D1Database({migrationsDir, migrationsTable: "drizzle_migrations"})` resource
 * (`worker/db/resources.ts`) that `deploy` applies — one migration path, nothing to
 * keep in sync. Per-file isolated stages give every file its own worker + D1, so
 * files run in parallel instead of the prior forced single fork that raced itself
 * (#547 / #220 / #560 — one root cause, ADR 0082).
 *
 * The test-author contract is unchanged from the prior single-shared-deploy harness
 * — `harness(getUrl)` exposes the same surface, only sourced from a per-file URL:
 *   - `h.url()`              — the deployed worker URL for this file's stage
 *   - `h.fate(op, opts)`     — POST one fate operation, return its single result
 *   - `h.fateBatch(...)`     — POST several fate operations at once
 *   - `h.signUp(...)`        — sign up a user through `/api/auth/*`, return cookie
 *   - `h.seedTerm(...)`      — seed a sözlük term+definitions via the PUBLIC fate
 *                             `definition.add` mutation (+ votes for scores)
 *   - `h.setLastActivityAt(...)` — controlled D1 write of a term's `last_activity_at`
 *                             (setup-only, real-D1 REST; the clock the seam can't set)
 *   - `h.execD1(...)`        — one setup-only SQL statement against this stage's real
 *                             D1 (real-D1 REST; e.g. drop an FTS table to inject a fault)
 *   - `h.json(...)` / `h.req(...)` — raw HTTP helpers
 *   - `h.openSse(...)` / `readFrame(...)` — live SSE transport helpers
 */

import {
	awaitEdgeReady,
	CloudflarePlaceholder404Error,
	isCloudflarePlaceholder404,
} from "./_edge-ready.ts";

/** A fate wire result for a single operation. */
export type FateResult =
	| {ok: true; data: unknown; id: string}
	| {ok: false; error: {code: string; message?: string}; id: string};

/** A single fate operation (the `version`/`operations` envelope is added for you). */
export type FateOp = Record<string, unknown> & {id?: string};

export interface Harness {
	/** The deployed worker URL (published by the global setup). */
	url(): string;
	/**
	 * Raw fetch against the worker; retries transient *connection* failures. Pass
	 * `timeoutMs` to bound a single attempt (a stall aborts and surfaces as a
	 * `TimeoutError`); omit it (default 0 = unbounded) for long-lived streams like
	 * SSE, which must stay open.
	 */
	req(path: string, init?: RequestInit, opts?: {timeoutMs?: number}): Promise<Response>;
	/** POST JSON against the worker (adds `content-type` + dev `origin`). */
	json(path: string, body: unknown, cookie?: string): Promise<Response>;
	/**
	 * POST one fate operation; return its single result. Reads (`kind: "query"`
	 * / `"list"`) auto-retry on a transient stall/error; mutations retry only when
	 * `retry: true` is passed (the caller asserting the op is idempotent, e.g.
	 * `definition.vote`).
	 */
	fate(op: FateOp, opts?: {cookie?: string; retry?: boolean}): Promise<FateResult>;
	/** POST several fate operations; return all results in order. */
	fateBatch(ops: FateOp[], opts?: {cookie?: string}): Promise<FateResult[]>;
	/** Sign up a user through better-auth; return `{userId, cookie}`. */
	signUp(email: string, password: string, name: string): Promise<{userId: string; cookie: string}>;
	/**
	 * Seed a sözlük term with definitions through the PUBLIC fate protocol — the
	 * same `definition.add` mutation the app uses (the dev-only admin route is
	 * gone). Each definition is added under a real session for its `authorName`
	 * (signed up on demand and cached); a definition's `score` is realized by
	 * casting that many up-votes from a shared pool of throwaway voters. Because
	 * identity now comes from the session, the returned per-definition rows carry
	 * the REAL `id`/`authorId` the worker assigned — assert against those, not a
	 * caller-chosen id.
	 *
	 * The input `authorName` is a BASE — the stored `author_name` is uniquified per
	 * run (`<base>-<run-stamp>`) so a fixed handle can't collide with a pre-existing
	 * actor on the shared stage (#2116). The returned rows carry that REAL stored
	 * `authorName`; assert `author` against `definitions[i].authorName`, never the base.
	 *
	 * Re-seeding the same `(slug, body)` is idempotent: the body is skipped (not
	 * re-added), mirroring the old admin upsert's dedup. `created` is true only the
	 * first time a slug is seeded in this process.
	 */
	seedTerm(input: {
		slug: string;
		title: string;
		definitions: Array<{authorName: string; body: string; score?: number}>;
	}): Promise<{
		slug: string;
		created: boolean;
		insertedDefinitions: number;
		skippedDefinitions: number;
		definitions: Array<{id: string; authorId: string; authorName: string; score: number}>;
	}>;
	/**
	 * Re-stamp a term's `last_activity_at` to "now" through the PUBLIC seam — a
	 * fresh voter casts a single up-vote on `definitionId`, which the worker counts
	 * as activity and funnels through `recomputeTermSummary(now)` (`Sozluk.ts`).
	 * This is the only HTTP-realizable handle on the `recent` keyset's lead column:
	 * the worker stamps `last_activity_at` from the real write clock (truncated to
	 * the second), never from caller input, so the integration `recent`-ordering
	 * vertical controls relative activity by the ORDER + SPACING of touches, not by
	 * injecting a timestamp. Returns the score the vote landed.
	 */
	touchTerm(definitionId: string): Promise<number>;
	/**
	 * Stamp a term's `term_record.last_activity_at` to an EXACT whole-second epoch,
	 * by-passing the server write clock — the deterministic handle the public seam
	 * cannot give. `last_activity_at` is server-stamped (`recomputeTermSummary` writes
	 * `floor(now/1000)`, `Sozluk.ts`) and never settable by caller input, so two
	 * touches tie on a second only when they happen to land in the same wall-clock
	 * second — a race that real remote D1's round-trip latency loses far more often
	 * than not (#643). This issues a controlled `UPDATE` against the per-stage real D1
	 * over the Cloudflare D1 REST API (NOT the worker binding — the black-box contract
	 * holds for assertions; this is setup-only), so a keyset tie is CONSTRUCTED, not
	 * raced. `epochSeconds` is the whole-second value the column stores. Only valid for
	 * a term that already has a `term_record` row (seed it first).
	 */
	setLastActivityAt(slug: string, epochSeconds: number): Promise<void>;
	/**
	 * Run one setup-only SQL statement against this stage's real D1 over the
	 * Cloudflare REST API — the same off-the-binding seam `setLastActivityAt` uses
	 * (NOT the worker binding; the black-box contract holds for assertions). The one
	 * fault-injection a black-box HTTP test cannot reach through the public worker:
	 * corrupting D1 *infrastructure* (e.g. dropping an FTS virtual table) to prove the
	 * read path surfaces the failure as an error rather than masking it as an empty
	 * result (#549). Returns D1's affected-row count (0 for DDL); throws on a
	 * D1-reported SQL error.
	 */
	execD1(sql: string, params?: unknown[]): Promise<number>;
	/**
	 * Promote an account to `yazar` by flipping its `user.tier` column directly over the
	 * same setup-only D1 REST seam as `execD1` — the test-harness analogue of the server's
	 * `Pasaport.promoteToYazar` (there is no public promotion mutation to drive black-box).
	 * Needed since #1810's "earn to vote" gate: a freshly signed-up account is a `çaylak`
	 * (the column default) and is REJECTED at cast, so any test that must land a real vote
	 * (seeding a score, asserting the vote round-trip) promotes its voter first. Setup-only,
	 * never an assertion.
	 */
	promoteToYazar(userId: string): Promise<void>;
	/**
	 * This stage's real D1 REST coordinates — `{accountId, databaseId}` — for a
	 * setup tool that must drive D1 over the same Cloudflare REST seam off the
	 * worker binding (the fts-backfill CLI's `makeD1RestFromEnv`, #645). Read straight
	 * off the deploy's compiled `Stack` output (#692), the same id `execD1` uses.
	 * Setup-only, never an assertion.
	 */
	d1Target(): Promise<{accountId: string; databaseId: string}>;
	/** Open a live SSE stream on a connection id (cookie required). */
	openSse(connectionId: string, cookie: string): Promise<Response>;
	/** Drive a `/fate/live` control message (subscribe / unsubscribe). */
	liveControl(
		connectionId: string,
		operations: Array<Record<string, unknown>>,
		cookie: string,
	): Promise<Response>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The Cloudflare edge-placeholder-404 detector + its typed carrier now live in the shared
// readiness primitive (`_edge-ready.ts`, ADR 0127) — `req` below imports them so its inline
// placeholder detection and `awaitEdgeReady`'s scoped tolerance share ONE definition.

// A per-request timeout fires an `AbortSignal.timeout` → the fetch rejects with a
// `TimeoutError`/`AbortError`. We treat that as "the request STALLED" (distinct
// from a connection error, which means it never reached the worker). A stall may
// have partially applied a write, so only *idempotent* callers retry on it.
const isAbort = (e: unknown): boolean =>
	e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

// One HTTP request that stalls past this is aborted and (for idempotent ops)
// retried against a fresh connection. The worker talks to real remote Cloudflare
// D1; a request can occasionally hang outright — without this bound the whole test
// waits out the Vitest timeout and dies with "All fibers interrupted". 30s is high
// enough not to chop a legitimately slow round-trip to remote D1, while still
// catching a true hang and leaving room to retry inside the 120s test budget.
const REQUEST_TIMEOUT_MS = 30_000;

// A `/fate/live` response is READY only when the edge served the worker's real held
// SSE stream (200 + `text/event-stream`). Every other outcome — the placeholder-404,
// the 503 cold-start envelope, or any other not-yet-serving status — is "retry", never
// terminal: more tolerant is the point (the opposite of the #1060 early-stop regression).
const sseReady = (res: Response): boolean =>
	res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/event-stream");

// A `/fate/live` CONTROL (subscribe/unsubscribe) POST against a cold topic-role LiveDO
// returns the worker's 503 `LIVE_UNAVAILABLE` cold-start envelope (`fate-live/route.ts`),
// exactly the "not ready yet, retry" signal `sseReady` rides out on the held-stream open
// (#1074) — only the un-streamed control POST never had the same readiness wait, so a cold
// subscribe surfaced the raw 503 as `expected 503 to be 200` (#1173). A 503 is therefore
// NOT ready; anything else IS — a genuine subscribe 200, OR a real error the test must
// still see (only the cold-start 503 is retried, never a real failure masked).
const liveControlReady = (res: Response): boolean => res.status !== 503;

// Unique per-process stamp for seeded author/voter emails. Each file owns its own
// isolated stage + D1, but a `NO_DESTROY` re-run reuses the same stage's D1, so a
// fresh stamp per process keeps re-run seed identities from colliding with users a
// prior run left behind.
const STAMP_SEED = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

// The CF REST bearer token — the SAME one the integration deploy uses
// (`CLOUDFLARE_API_TOKEN`, `_integration.ts`). The account + database id come off the
// deploy's compiled output (`getD1Target`), not the env, so this is the only env
// credential the setup-only D1 REST path still needs. Resolved lazily so a file that
// never touches D1 needs neither.
const cloudflareApiToken = (): string => {
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set (needed for setLastActivityAt)");
	return token;
};

// One authenticated request to the Cloudflare REST API; throws on a non-2xx with the
// response body for diagnosis. Setup-only — never on a test's black-box assertion path.
async function cloudflareApi(path: string, init?: RequestInit): Promise<Response> {
	const res = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${cloudflareApiToken()}`,
			"content-type": "application/json",
			...init?.headers,
		},
	});
	if (!res.ok) {
		throw new Error(
			`Cloudflare API ${init?.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`,
		);
	}
	return res;
}

/**
 * Read one SSE event (frames are delimited by a blank line) off a stream reader,
 * buffering across reads. Returns the frame text (without the trailing `\n\n`).
 */
export async function readFrame(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	decoder: TextDecoder,
	buffer: {value: string},
	maxReads = 120,
): Promise<string> {
	for (let i = 0; i < maxReads; i++) {
		const idx = buffer.value.indexOf("\n\n");
		if (idx !== -1) {
			const frame = buffer.value.slice(0, idx);
			buffer.value = buffer.value.slice(idx + 2);
			return frame;
		}
		const {value, done} = await reader.read();
		if (done) return buffer.value;
		buffer.value += decoder.decode(value, {stream: true});
	}
	throw new Error("timed out waiting for SSE frame");
}

/**
 * Read frames until a real `event:` frame arrives, skipping SSE comment frames
 * (`: connected`, `: heartbeat`). The transport injects heartbeats while a stream
 * is held, so a data assertion must skip past them.
 */
export async function readEvent(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	decoder: TextDecoder,
	buffer: {value: string},
	maxFrames = 20,
): Promise<string> {
	for (let i = 0; i < maxFrames; i++) {
		const frame = await readFrame(reader, decoder, buffer);
		if (frame.includes("event:")) return frame;
	}
	throw new Error("timed out waiting for an SSE event frame (only comments seen)");
}

/** Parse the `data: …` line of an SSE frame as JSON. */
export function frameData<T = unknown>(frame: string): T {
	const line = frame.split("\n").find((l) => l.startsWith("data: "));
	if (!line) throw new Error(`SSE frame has no data line:\n${frame}`);
	return JSON.parse(line.slice("data: ".length)) as T;
}

/**
 * Build the HTTP harness over a deployed-worker URL accessor. The harness does NOT
 * deploy — `integrationStack()` (`_integration.ts`) owns the per-file `Test.make`
 * lifecycle and supplies `getUrl`, which resolves to this file's stage's worker URL
 * (populated by the `beforeAll(deploy(Stack))` hook before any `it` body runs).
 *
 * `getD1Target` resolves this stage's real D1 REST coordinates —
 * `{accountId, databaseId}` — read straight off the deploy's compiled `Stack`
 * output (alchemy `Cloudflare.D1Database` surfaces `databaseId`/`accountId`), the
 * same hook that populates `getUrl`. The harness no longer reconstructs the D1's
 * physical name and prefix-matches the CF list API (#692, retiring #689's
 * `MAX_STAGE_LEN`); it reads the id the deploy already knows.
 */
export function harness(
	getUrl: () => string,
	getD1Target: () => {accountId: string; databaseId: string},
): Harness {
	const url = () => {
		const u = getUrl();
		if (!u) {
			throw new Error(
				"integration worker URL is not set — beforeAll(deploy(Stack)) has not resolved. " +
					"Build the harness via integrationStack() so the per-file deploy runs first.",
			);
		}
		return u;
	};

	const req: Harness["req"] = async (path, init, opts) => {
		const timeoutMs = opts?.timeoutMs ?? 0;
		let lastErr: unknown;
		for (let i = 0; i < 20; i++) {
			try {
				const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : init?.signal;
				const res = await fetch(`${url()}${path}`, signal ? {...init, signal} : init);
				// A 404 might be Cloudflare's not-yet-propagated edge placeholder rather
				// than a real worker 404. Peek a clone's body (only on a 404, so the hot
				// path is untouched) and, if it is the placeholder, treat it like a
				// connection error and retry on the same bounded loop — a fresh edge
				// settles within a few seconds. A real application 404 (structured JSON)
				// never matches, so it is returned unretried.
				if (res.status === 404) {
					const peek = await res.clone().text();
					if (isCloudflarePlaceholder404(res.status, peek)) {
						// Typed (not string-matched) so `awaitEdgeReady` can ride ONLY this out on
						// its 60s budget while a real failure still surfaces at once (#1689, ADR 0127).
						lastErr = new CloudflarePlaceholder404Error(path);
						await sleep(250);
						continue;
					}
				}
				return res;
			} catch (err) {
				// A stall (abort/timeout) may have partially applied a write, so it is
				// NOT safe to silently retry here — surface it and let the idempotency-
				// aware caller (`fate`, `signUp`) decide. A connection error never
				// reached the worker, so retry it (covers worker-not-up-yet at startup).
				if (isAbort(err)) throw err;
				lastErr = err;
				await sleep(250);
			}
		}
		throw lastErr;
	};

	// Every JSON POST is time-bounded so a stalled D1-backed request aborts instead
	// of hanging the whole test. SSE (`openSse`) deliberately bypasses this — its
	// response body stays open for the life of the stream.
	const json: Harness["json"] = (path, body, cookie) =>
		req(
			path,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "http://localhost:3000",
					...(cookie ? {cookie} : {}),
				},
				body: JSON.stringify(body),
			},
			{timeoutMs: REQUEST_TIMEOUT_MS},
		);

	const fateBatch: Harness["fateBatch"] = async (ops, opts) => {
		const operations = ops.map((op, i) => ({id: String(i + 1), ...op}));
		const res = await json("/fate", {version: 1, operations}, opts?.cookie);
		const parsed = (await res.json()) as {results: FateResult[]};
		return parsed.results;
	};

	// Reads are always safe to replay; a mutation only when the caller flags it
	// idempotent (`definition.vote` re-cast is a no-op — `Vote.ts`). `definition.add`
	// is NOT idempotent (new id per call), so it is never auto-retried here — its
	// caller (`addDefinition`) adopts the landed row by body instead.
	const idempotentOp = (op: FateOp, opts?: {retry?: boolean}): boolean =>
		op.kind === "query" || op.kind === "list" || opts?.retry === true;

	const fate: Harness["fate"] = async (op, opts) => {
		const attempts = idempotentOp(op, opts) ? 3 : 1;
		let lastResult: FateResult | undefined;
		let lastErr: unknown;
		for (let i = 0; i < attempts; i++) {
			try {
				const [result] = await fateBatch([op], opts);
				lastResult = result;
				lastErr = undefined;
				// Success, or a non-retryable op: take the result as-is. A retryable op
				// that came back `!ok` is a transient failure → loop and try again.
				if (result!.ok || attempts === 1) return result!;
			} catch (err) {
				lastErr = err;
				// Only a stall is retryable; a real error (or a non-retryable op) surfaces.
				if (attempts === 1 || !isAbort(err)) throw err;
			}
			if (i < attempts - 1) await sleep(300 * (i + 1));
		}
		if (lastResult) return lastResult;
		throw lastErr;
	};

	// A sign-up/sign-in POST is idempotent end-to-end (a 422 USER_ALREADY_EXISTS
	// falls back to sign-in), so a stalled attempt is safe to replay. better-auth
	// also intermittently returns a transient 5xx on a cold worker's first D1 write
	// (a flake that killed a whole suite's beforeAll, #32), so a 5xx is retried like
	// a stall — bounded, never a 4xx (a real client error, e.g. the 422 the caller
	// handles). The final attempt's response is returned as-is, so a persistent 5xx
	// still surfaces clearly through signUp's `sign-up failed: <status>` throw.
	const postIdempotent = async (
		path: string,
		body: unknown,
		cookie?: string,
	): Promise<Response> => {
		let lastErr: unknown;
		for (let i = 0; i < 3; i++) {
			try {
				const res = await json(path, body, cookie);
				if (res.status < 500 || i === 2) return res;
				await sleep(300 * (i + 1));
			} catch (err) {
				lastErr = err;
				if (!isAbort(err)) throw err;
				await sleep(300 * (i + 1));
			}
		}
		throw lastErr;
	};

	// Extract the session (`name=value` cookie + user id) from a better-auth
	// sign-up OR sign-in response — the two share a response shape, so both the
	// fresh-user and existing-user paths converge here.
	// A better-auth POST that additionally rides a cold per-PR-preview edge's placeholder-404
	// (the route not yet propagated) out on the shared readiness budget — the auth-signup caller
	// of `awaitEdgeReady` (ADR 0127; the #1717 point-fix folded into the primitive). `req` already
	// converts that edge transient into a THROWN typed `CloudflarePlaceholder404Error` (never a
	// real worker response) after its own short loop, and `postIdempotent` re-raises it (it isn't
	// an abort). So any Response that exits `postIdempotent` is a real worker answer and is READY
	// (`ready: () => true`) — only the thrown placeholder-404 is retried under the deadline. A
	// genuine 4xx (the 422 USER_ALREADY_EXISTS the caller handles, any validation error) is a real
	// response, so it returns AT ONCE and is never swallowed into the budget.
	const postAuthReady = (path: string, body: unknown, cookie?: string): Promise<Response> =>
		awaitEdgeReady(
			() => postIdempotent(path, body, cookie),
			() => true,
		);

	const sessionFrom = async (
		res: Response,
		ctx: string,
	): Promise<{userId: string; cookie: string}> => {
		const setCookie = res.headers.get("set-cookie");
		if (!setCookie) throw new Error(`${ctx} returned no set-cookie`);
		// `set-cookie` may carry attributes (Path, HttpOnly, …); keep just `name=value`.
		const cookie = setCookie
			.split(/,(?=[^;]+=)/)
			.map((part) => part.split(";")[0]!.trim())
			.filter((kv) => kv.includes("="))
			.join("; ");
		const data = (await res.json()) as {user?: {id: string}};
		if (!data.user?.id) throw new Error(`${ctx} returned no user id`);
		return {userId: data.user.id, cookie};
	};

	const signUp: Harness["signUp"] = async (email, password, name) => {
		const res = await postAuthReady("/api/auth/sign-up/email", {email, password, name});
		if (res.ok) return sessionFrom(res, "sign-up");
		// Idempotent against the real remote D1 this file's stage deploys: a
		// `NO_DESTROY` re-run reuses the same D1, so a seed user left by a prior run
		// makes sign-up 422 USER_ALREADY_EXISTS. Fall back to sign-in so re-seeding a
		// fixture is a no-op, not a hard fail.
		const body = await res.text();
		if (res.status === 422 && body.includes("USER_ALREADY_EXISTS")) {
			const signIn = await postAuthReady("/api/auth/sign-in/email", {email, password});
			if (!signIn.ok) {
				throw new Error(
					`sign-in (existing seed user) failed: ${signIn.status} ${await signIn.text()}`,
				);
			}
			return sessionFrom(signIn, "sign-in");
		}
		throw new Error(`sign-up failed: ${res.status} ${body}`);
	};

	// Per-harness seeding state. A `definition.add` write is identity-bearing
	// (author = session user) and scores are vote-derived, so seeding drives the
	// same public surface the app does: one cached session per distinct
	// `authorName`, and a shared, lazily-grown pool of throwaway voters that each
	// cast a single up-vote to realize a definition's `score`.
	let seedCounter = 0;
	const nextSeedId = () => `seed-${STAMP_SEED}-${seedCounter++}`;

	// The seeded author identity is uniquified PER RUN at this source: the stored `author_name`
	// (`user.name ?? user.email`) is the requested base + the per-process `STAMP_SEED`, so no two
	// runs — and no actor already present on the run-scoped SHARED stage (ADR 0104) — can collide
	// on it. Fixed identity + a shared mutable stage was the nondeterministic-read root cause
	// (#2116: `expected 'yazar' to be 'umut'` — a fixed `umut` handle colliding with a pre-existing
	// stage actor). Callers assert against the RETURNED `authorName` (threaded through `seedTerm`),
	// never the requested base literal, since the two now differ.
	const runAuthorName = (base: string): string => `${base}-${STAMP_SEED}`;
	const authorCookies = new Map<string, string>();
	const authorCookie = async (base: string): Promise<{cookie: string; authorName: string}> => {
		const authorName = runAuthorName(base);
		const existing = authorCookies.get(authorName);
		if (existing) return {cookie: existing, authorName};
		const {cookie} = await signUp(`${nextSeedId()}@seed.local`, "seedpass-seedpass", authorName);
		authorCookies.set(authorName, cookie);
		return {cookie, authorName};
	};

	// Grow-only pool of voter cookies, sized on demand. Each voter is a distinct
	// session, so `voterPool[0..n)` are n distinct up-votes for a single target.
	// Each is PROMOTED to yazar right after signup: a fresh account is a çaylak and,
	// since #1810's "earn to vote" gate, would be rejected at cast — a seed voter exists
	// solely to realize a score, so it must be above the newcomer floor.
	const voterPool: string[] = [];
	const voters = async (n: number): Promise<string[]> => {
		while (voterPool.length < n) {
			const {cookie, userId} = await signUp(
				`${nextSeedId()}@vote.local`,
				"voterpass-voterpass",
				"voter",
			);
			await promoteToYazar(userId);
			voterPool.push(cookie);
		}
		return voterPool.slice(0, n);
	};

	// `(slug, body)` dedup so re-seeding is idempotent (the old admin upsert
	// skipped already-present bodies; the public mutation would otherwise insert
	// a duplicate definition).
	const seededBodies = new Set<string>();
	const seededSlugs = new Set<string>();

	// Find an already-landed definition by its body, so a stalled `definition.add`
	// (which may have committed before the response was lost) is adopted rather
	// than re-inserted as a duplicate. Reads auto-retry, so this is robust.
	const findDefByBody = async (
		cookie: string,
		slug: string,
		body: string,
	): Promise<{id: string; authorId: string} | undefined> => {
		const t = await fate(
			{
				kind: "query",
				name: "term",
				args: {slug, definitions: {first: 100}},
				select: ["definitions.id", "definitions.body", "definitions.authorId"],
			},
			{cookie},
		);
		if (!t.ok || t.data == null) return undefined;
		const conn = (
			t.data as {definitions?: {items: Array<{node: {id: string; body: string; authorId: string}}>}}
		).definitions;
		const hit = conn?.items.find((e) => e.node.body === body);
		return hit ? {id: hit.node.id, authorId: hit.node.authorId} : undefined;
	};

	// `definition.add` is not idempotent, so we can't blind-retry it. On a stall
	// (the add may or may not have committed) we look the body up: if it landed,
	// adopt it; otherwise add again. A `!ok` result is also treated this way.
	const addDefinition = async (
		cookie: string,
		slug: string,
		title: string,
		body: string,
	): Promise<{id: string; authorId: string}> => {
		let lastErr: unknown;
		for (let i = 0; i < 3; i++) {
			try {
				const added = await fate(
					{
						kind: "mutation",
						name: "definition.add",
						input: {termSlug: slug, termTitle: title, body},
						select: ["id", "authorId"],
					},
					{cookie},
				);
				if (added.ok) return added.data as {id: string; authorId: string};
				lastErr = new Error(`definition.add (${slug}): ${added.error.code}`);
			} catch (err) {
				if (!isAbort(err)) throw err;
				lastErr = err;
			}
			const adopted = await findDefByBody(cookie, slug, body);
			if (adopted) return adopted;
			await sleep(400 * (i + 1));
		}
		throw new Error(`seedTerm add failed (${slug}) after retries: ${String(lastErr)}`);
	};

	const seedTerm: Harness["seedTerm"] = async (input) => {
		const created = !seededSlugs.has(input.slug);
		seededSlugs.add(input.slug);

		let insertedDefinitions = 0;
		let skippedDefinitions = 0;
		const definitions: Array<{id: string; authorId: string; authorName: string; score: number}> =
			[];

		// Sequential on purpose: term creation/extension and the per-definition
		// vote writes share the slug's term_record row; concurrent writes would
		// race the denormalized aggregates.
		for (const def of input.definitions) {
			const key = `${input.slug} ${def.body}`;
			if (seededBodies.has(key)) {
				skippedDefinitions++;
				continue;
			}
			seededBodies.add(key);

			const {cookie, authorName} = await authorCookie(def.authorName);
			const node = await addDefinition(cookie, input.slug, input.title, def.body);
			insertedDefinitions++;

			const score = def.score ?? 0;
			if (score > 0) {
				// Distinct voters, one up-vote each → score === number of voters.
				// `definition.vote` is idempotent (re-cast is a no-op), so a stalled
				// vote is safe to replay — `retry: true`.
				const cookies = await voters(score);
				for (const voterCookie of cookies) {
					const voted = await fate(
						{kind: "mutation", name: "definition.vote", input: {id: node.id}, select: ["score"]},
						{cookie: voterCookie, retry: true},
					);
					if (!voted.ok) {
						throw new Error(`seedTerm vote failed (${node.id}): ${voted.error.code}`);
					}
				}
			}

			definitions.push({
				id: node.id,
				authorId: node.authorId,
				// The REAL stored `author_name` (uniquified per run), not the requested base —
				// the deployed row carries this, so an id-pinned read asserting `author` must
				// compare against it, never the base literal (#2116).
				authorName,
				score,
			});
		}

		return {slug: input.slug, created, insertedDefinitions, skippedDefinitions, definitions};
	};

	// Each touch is a NEW voter's first up-vote, so `voteResult.changed` is true and
	// the worker re-runs `recomputeTermSummary(now)` (a duplicate vote is a no-op and
	// would NOT re-stamp activity). `definition.vote` is idempotent, so the stalled-
	// request replay is safe.
	const touchTerm: Harness["touchTerm"] = async (definitionId) => {
		// Grow the pool by one and take the NEW voter (last slot): an already-pooled
		// voter may have up-voted this definition before, making the re-cast a no-op
		// that would NOT re-stamp activity. A never-seen voter guarantees `changed`.
		const pool = await voters(voterPool.length + 1);
		const voterCookie = pool[pool.length - 1]!;
		const voted = await fate(
			{kind: "mutation", name: "definition.vote", input: {id: definitionId}, select: ["score"]},
			{cookie: voterCookie, retry: true},
		);
		if (!voted.ok) throw new Error(`touchTerm vote failed (${definitionId}): ${voted.error.code}`);
		return (voted.data as {score: number}).score;
	};

	// One setup-only statement against this stage's real D1 over the REST query API.
	// Returns D1's reported affected-row count (0 for DDL); throws on a D1-side SQL
	// error so a botched setup statement fails the test loudly, never silently. The
	// `{accountId, databaseId}` come straight off the deploy's compiled output
	// (`getD1Target`) — the id the deploy already knows, never a reconstructed name (#692).
	const runD1Query = async (sql: string, params: unknown[]): Promise<number> => {
		const {accountId: acct, databaseId} = getD1Target();
		const res = await cloudflareApi(`/accounts/${acct}/d1/database/${databaseId}/query`, {
			method: "POST",
			body: JSON.stringify({sql, params}),
		});
		const body = (await res.json()) as {
			result?: Array<{meta?: {changes?: number}}>;
			errors?: Array<{message: string}>;
		};
		if (body.errors?.length) {
			throw new Error(`D1 query failed (${sql}): ${body.errors.map((e) => e.message).join("; ")}`);
		}
		return body.result?.[0]?.meta?.changes ?? 0;
	};

	const setLastActivityAt: Harness["setLastActivityAt"] = async (slug, epochSeconds) => {
		const changes = await runD1Query("UPDATE term_record SET last_activity_at = ? WHERE slug = ?", [
			epochSeconds,
			slug,
		]);
		if (changes !== 1) {
			throw new Error(`setLastActivityAt(${slug}): expected 1 row updated, got ${changes}`);
		}
	};

	const execD1: Harness["execD1"] = (sql, params = []) => runD1Query(sql, params);

	const promoteToYazar: Harness["promoteToYazar"] = async (userId) => {
		const changes = await runD1Query(`UPDATE "user" SET tier = 'yazar' WHERE id = ?`, [userId]);
		if (changes !== 1) {
			throw new Error(`promoteToYazar(${userId}): expected 1 row updated, got ${changes}`);
		}
	};

	const d1Target: Harness["d1Target"] = async () => getD1Target();

	// A dedicated-stage `/fate/live` open can draw a cold edge well past the `req` loop's
	// ~5s placeholder-404 window: the route is brand-new AND the LiveDO is cold, so the first
	// open can surface either the Cloudflare placeholder-404 (edge route not yet propagated —
	// `req` retries it briefly then THROWS a `CloudflarePlaceholder404Error`) OR the worker's
	// 503 `LIVE_UNAVAILABLE` cold-start envelope (`fate-live/cold-start-retry.ts`, a not-ready
	// RESPONSE) before it serves the held SSE stream. Both are "not ready yet, retry", NOT a
	// real failure — so the shared `awaitEdgeReady` rides BOTH out on the SAME generous budget (the
	// thrown placeholder-404 no longer escapes at ~5s, #1689) and only returns once the edge serves
	// the worker's real SSE response (200 + `text/event-stream`).
	const openSse: Harness["openSse"] = (connectionId, cookie) => {
		const path = `/fate/live?connectionId=${encodeURIComponent(connectionId)}`;
		const init: RequestInit = {headers: {accept: "text/event-stream", cookie}};
		return awaitEdgeReady(() => req(path, init), sseReady);
	};

	// The subscribe/unsubscribe control POST shares the cold-topic-role-DO hazard with the
	// held-stream open above: a not-yet-warm topic DO answers 503 `LIVE_UNAVAILABLE`, so this
	// rides the SAME shared `awaitEdgeReady` budget (`liveControlReady` — only the cold-start 503
	// is retried) instead of surfacing the raw 503 as `expected 503 to be 200` (#1173).
	const liveControl: Harness["liveControl"] = (connectionId, operations, cookie) =>
		awaitEdgeReady(
			() => json("/fate/live", {version: 1, connectionId, operations}, cookie),
			liveControlReady,
		);

	return {
		url,
		req,
		json,
		fate,
		fateBatch,
		signUp,
		seedTerm,
		touchTerm,
		setLastActivityAt,
		execD1,
		promoteToYazar,
		d1Target,
		openSse,
		liveControl,
	};
}
