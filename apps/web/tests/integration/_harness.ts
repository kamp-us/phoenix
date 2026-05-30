/**
 * Integration-test harness — alchemy/Test deploy + black-box HTTP (ADR 0026–0031,
 * `.patterns/alchemy-stack-deploy.md`).
 *
 * The old harness ran tests *inside* workerd via `@cloudflare/vitest-pool-workers`.
 * That pool cannot load the alchemy `Cloudflare.Worker` — it transitively imports
 * alchemy's bundler (rolldown's native `.node` binding + Node-only modules) and
 * workerd can't load it. The new harness instead **deploys the real stack to a
 * local workerd** (`dev: true` + `Alchemy.localState()`, fully offline) and asserts
 * **black-box over HTTP** against the deployed URL. No `cloudflare:test`, no
 * `SELF.fetch`, no `env.PHOENIX_DB`, no `runInDurableObject`.
 *
 * WHERE THE DEPLOY HAPPENS — and why it's `globalSetup`, not `beforeAll`:
 * the alchemy dev sidecar (`@distilled.cloud/cloudflare-runtime`) brings up a
 * Node-side LoopbackServer that the worker calls back into for D1/storage. Inside
 * a Vitest *pool worker* (forks/threads) that loopback loses a `net.Server`
 * address race and the whole worker becomes unreachable (and the failure is an
 * uninterruptible hang, so a `beforeAll` retry can't recover). In Vitest's **main
 * process** — same context the `alchemy` CLI runs in — the sidecar comes up
 * cleanly every time. So the stack is deployed once in `tests/integration/_global-setup.ts`
 * (main process), which publishes the URL via `PHOENIX_TEST_URL`; the test files
 * run in the pool and only make HTTP requests against that URL. `installLocalhostDns()`
 * is called in both places so `fetch("http://phoenix.localhost:<port>/…")` resolves
 * (`*.localhost` is not resolvable by default on macOS).
 *
 * Each test file calls `harness()` at module top level (NOT a deploy — just reads
 * the published URL) and uses:
 *   - `h.url()`              — the deployed worker URL
 *   - `h.fate(op, opts)`     — POST one fate operation, return its single result
 *   - `h.fateBatch(...)`     — POST several fate operations at once
 *   - `h.signUp(...)`        — sign up a user through `/api/auth/*`, return cookie
 *   - `h.seedTerm(...)`      — seed a sözlük term+definitions via the admin route
 *   - `h.json(...)` / `h.req(...)` — raw HTTP helpers
 *   - `h.openSse(...)` / `readFrame(...)` — live SSE transport helpers
 */
import {installLocalhostDns} from "./_localhost-dns.ts";

installLocalhostDns();

/** A fate wire result for a single operation. */
export type FateResult =
	| {ok: true; data: unknown; id: string}
	| {ok: false; error: {code: string; message?: string}; id: string};

/** A single fate operation (the `version`/`operations` envelope is added for you). */
export type FateOp = Record<string, unknown> & {id?: string};

export interface Harness {
	/** The deployed worker URL (published by the global setup). */
	url(): string;
	/** Raw fetch against the worker; retries transient connection failures. */
	req(path: string, init?: RequestInit): Promise<Response>;
	/** POST JSON against the worker (adds `content-type` + dev `origin`). */
	json(path: string, body: unknown, cookie?: string): Promise<Response>;
	/** POST one fate operation; return its single result. */
	fate(op: FateOp, opts?: {cookie?: string}): Promise<FateResult>;
	/** POST several fate operations; return all results in order. */
	fateBatch(ops: FateOp[], opts?: {cookie?: string}): Promise<FateResult[]>;
	/** Sign up a user through better-auth; return `{userId, cookie}`. */
	signUp(email: string, password: string, name: string): Promise<{userId: string; cookie: string}>;
	/** Seed a sözlük term with definitions via the dev-only admin route. */
	seedTerm(input: {
		slug: string;
		title: string;
		definitions: Array<{authorId: string; authorName: string; body: string; score?: number}>;
	}): Promise<{slug: string; created: boolean}>;
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
 * Read the deployed worker URL published by the global setup. The harness does
 * NOT deploy — `_global-setup.ts` (main process) owns the stack lifecycle.
 */
export function harness(): Harness {
	const url = () => {
		const u = process.env.PHOENIX_TEST_URL;
		if (!u) {
			throw new Error(
				"PHOENIX_TEST_URL is not set — the integration global setup did not run. " +
					"Run via `pnpm test` (vitest config wires tests/integration/_global-setup.ts).",
			);
		}
		return u;
	};

	const req: Harness["req"] = async (path, init) => {
		let lastErr: unknown;
		for (let i = 0; i < 20; i++) {
			try {
				return await fetch(`${url()}${path}`, init);
			} catch (err) {
				lastErr = err;
				await sleep(250);
			}
		}
		throw lastErr;
	};

	const json: Harness["json"] = (path, body, cookie) =>
		req(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:3000",
				...(cookie ? {cookie} : {}),
			},
			body: JSON.stringify(body),
		});

	const fateBatch: Harness["fateBatch"] = async (ops, opts) => {
		const operations = ops.map((op, i) => ({id: String(i + 1), ...op}));
		const res = await json("/fate", {version: 1, operations}, opts?.cookie);
		const parsed = (await res.json()) as {results: FateResult[]};
		return parsed.results;
	};

	const fate: Harness["fate"] = async (op, opts) => {
		const [result] = await fateBatch([op], opts);
		return result!;
	};

	const signUp: Harness["signUp"] = async (email, password, name) => {
		const res = await json("/api/auth/sign-up/email", {email, password, name});
		if (!res.ok) {
			throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
		}
		const setCookie = res.headers.get("set-cookie");
		if (!setCookie) throw new Error("sign-up returned no set-cookie");
		// `set-cookie` may carry attributes (Path, HttpOnly, …); keep just `name=value`.
		const cookie = setCookie
			.split(/,(?=[^;]+=)/)
			.map((part) => part.split(";")[0]!.trim())
			.filter((kv) => kv.includes("="))
			.join("; ");
		const data = (await res.json()) as {user?: {id: string}};
		if (!data.user?.id) throw new Error("sign-up returned no user id");
		return {userId: data.user.id, cookie};
	};

	const seedTerm: Harness["seedTerm"] = async (input) => {
		const res = await json("/api/admin/sozluk/upsert-term", input);
		if (!res.ok) throw new Error(`seedTerm failed: ${res.status} ${await res.text()}`);
		return (await res.json()) as {slug: string; created: boolean};
	};

	const openSse: Harness["openSse"] = (connectionId, cookie) =>
		req(`/fate/live?connectionId=${encodeURIComponent(connectionId)}`, {
			headers: {accept: "text/event-stream", cookie},
		});

	const liveControl: Harness["liveControl"] = (connectionId, operations, cookie) =>
		json("/fate/live", {version: 1, connectionId, operations}, cookie);

	return {url, req, json, fate, fateBatch, signUp, seedTerm, openSse, liveControl};
}
