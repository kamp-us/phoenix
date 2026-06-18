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
 *   - `h.json(...)` / `h.req(...)` — raw HTTP helpers
 *   - `h.openSse(...)` / `readFrame(...)` — live SSE transport helpers
 */

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

// Cloudflare serves an HTML placeholder 404 (an `<h1>` reading "There is nothing
// here yet", with the Cloudflare branding rendered as an inline SVG logo — the
// literal string "Powered by Cloudflare" is NOT in the body) from an edge PoP that
// has NOT yet propagated a freshly deployed `*.workers.dev` route. The per-file-stage
// model stands up ~11 brand-new hostnames per run, so any test's FIRST request can
// draw a cold edge and get this page (#575). It is a propagation transient, not a
// real application 404 — the worker's own 404s are structured JSON
// (`{ok:false,error:{code}}`), never this HTML — so it is bounded-retryable where a
// genuine 404 is not. The `_integration.ts` health probe only warms one route at one
// PoP; this is the general backstop for the first request on every path.
const isCloudflarePlaceholder404 = (status: number, body: string): boolean =>
	status === 404 &&
	(body.includes("There is nothing here yet") || body.startsWith("<!DOCTYPE html>"));

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

// Unique per-process stamp for seeded author/voter emails. Each file owns its own
// isolated stage + D1, but a `NO_DESTROY` re-run reuses the same stage's D1, so a
// fresh stamp per process keeps re-run seed identities from colliding with users a
// prior run left behind.
const STAMP_SEED = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
 */
export function harness(getUrl: () => string): Harness {
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
						lastErr = new Error(`cloudflare placeholder 404 at ${path} (edge not propagated)`);
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
	// falls back to sign-in), so a stalled attempt is safe to replay.
	const postIdempotent = async (
		path: string,
		body: unknown,
		cookie?: string,
	): Promise<Response> => {
		let lastErr: unknown;
		for (let i = 0; i < 3; i++) {
			try {
				return await json(path, body, cookie);
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
		const res = await postIdempotent("/api/auth/sign-up/email", {email, password, name});
		if (res.ok) return sessionFrom(res, "sign-up");
		// Idempotent against the real remote D1 this file's stage deploys: a
		// `NO_DESTROY` re-run reuses the same D1, so a seed user left by a prior run
		// makes sign-up 422 USER_ALREADY_EXISTS. Fall back to sign-in so re-seeding a
		// fixture is a no-op, not a hard fail.
		const body = await res.text();
		if (res.status === 422 && body.includes("USER_ALREADY_EXISTS")) {
			const signIn = await postIdempotent("/api/auth/sign-in/email", {email, password});
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

	const authorCookies = new Map<string, string>();
	const authorCookie = async (authorName: string): Promise<string> => {
		const existing = authorCookies.get(authorName);
		if (existing) return existing;
		const {cookie} = await signUp(`${nextSeedId()}@seed.local`, "seedpass-seedpass", authorName);
		authorCookies.set(authorName, cookie);
		return cookie;
	};

	// Grow-only pool of voter cookies, sized on demand. Each voter is a distinct
	// session, so `voterPool[0..n)` are n distinct up-votes for a single target.
	const voterPool: string[] = [];
	const voters = async (n: number): Promise<string[]> => {
		while (voterPool.length < n) {
			const {cookie} = await signUp(`${nextSeedId()}@vote.local`, "voterpass-voterpass", "voter");
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
		// vote writes share the slug's term_summary row; concurrent writes would
		// race the denormalized aggregates.
		for (const def of input.definitions) {
			const key = `${input.slug} ${def.body}`;
			if (seededBodies.has(key)) {
				skippedDefinitions++;
				continue;
			}
			seededBodies.add(key);

			const cookie = await authorCookie(def.authorName);
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
				authorName: def.authorName,
				score,
			});
		}

		return {slug: input.slug, created, insertedDefinitions, skippedDefinitions, definitions};
	};

	const openSse: Harness["openSse"] = (connectionId, cookie) =>
		req(`/fate/live?connectionId=${encodeURIComponent(connectionId)}`, {
			headers: {accept: "text/event-stream", cookie},
		});

	const liveControl: Harness["liveControl"] = (connectionId, operations, cookie) =>
		json("/fate/live", {version: 1, connectionId, operations}, cookie);

	return {url, req, json, fate, fateBatch, signUp, seedTerm, openSse, liveControl};
}
