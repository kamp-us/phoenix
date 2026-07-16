/**
 * The single canonical D1 REST transport: a `D1Database`-shaped binding backed by
 * the Cloudflare D1 REST query API, so a package's drizzle reads/writes run from a
 * plain Node process (no workerd). It implements only the slice `drizzle-orm/d1`
 * drives — `prepare`/`bind`/`all`/`run`/`raw`/`first` and `batch`.
 *
 * One leaf, three consumers: `@kampus/preview-seed` (`seed`), `@kampus/fts-backfill`
 * (the FTS re-index), and `@kampus/moderator-grant` (`setRole`/`listModerators`) all
 * run their real direct-D1 path through this — the bins offline over the env layer,
 * the integration tiers against real D1 (ADR 0082, no faked engine). Before this leaf
 * each carried a hand-copy (issue #941), which is why the `meta.changes` defect had to
 * be fixed three times (#937/#940); now it's fixed once, here.
 *
 * Transport is `@distilled.cloud/cloudflare`'s `queryDatabase` (already in the tree
 * via alchemy). A single statement is one REST call; a drizzle `batch([...])` collects
 * every statement's sql+params into ONE REST `batch` call, which D1 runs as a single
 * atomic transaction — load-bearing for an all-or-none write. The adapter methods
 * return Promises and run the `queryDatabase` Effect with the provided credentials/HTTP
 * layer per call.
 */
import type {Credentials} from "@distilled.cloud/cloudflare/Credentials";
import {CredentialsFromEnv} from "@distilled.cloud/cloudflare/Credentials";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import {Effect, Layer} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type {HttpClient} from "effect/unstable/http/HttpClient";

/** The services `queryDatabase` requires; the bin's layer must provide exactly these. */
export type D1RestServices = Credentials | HttpClient;

type Params = ReadonlyArray<unknown>;

/**
 * Assert one bound param satisfies D1's REST `params` contract.
 * `@distilled.cloud/cloudflare`'s `queryDatabase` validates `params` as a strict
 * `string[]` and **rejects a `null`/`undefined` element** (`SchemaError: Expected
 * string, got null`), so a SQL NULL must be rendered *inline* in the statement text
 * — never bound as a `null` param. A consumer keeps nullable columns out of the wire
 * by leaving them unset in its statements (drizzle emits a literal `NULL`), so no
 * `null` ever reaches the transport (#569). A `null`/`undefined` here is a caller bug
 * (a nullable column bound instead of omitted); throw with the offending index. The
 * leaf's unit tier pins this contract directly and each consumer's integration tier
 * proves real D1 rejects null end to end — so the param shape can't drift from what
 * the live REST wire accepts (#571).
 */
export const assertRestParam = (param: unknown, index: number): void => {
	if (param == null) {
		throw new Error(
			`D1 REST param[${index}] is ${param}; D1 REST params is strict string[] and rejects null. ` +
				`Render SQL NULL inline (omit the nullable column from the insert), never bind null.`,
		);
	}
};

/** Stringify bound params for the REST wire, asserting each against {@link assertRestParam}. */
export const toRestParams = (params: Params): string[] =>
	params.map((p, i) => {
		assertRestParam(p, i);
		return String(p);
	});

interface BoundStub {
	readonly sql: string;
	readonly params: Params;
	all: <T = Record<string, unknown>>() => Promise<{results: T[]}>;
	run: () => Promise<{success: true; meta: Record<string, unknown>; results: unknown[]}>;
	raw: <T = unknown[]>() => Promise<T[]>;
	first: <T = Record<string, unknown>>() => Promise<T | null>;
}

interface PreparedStub extends BoundStub {
	bind: (...params: Params) => BoundStub;
}

export interface D1RestConfig {
	readonly accountId: string;
	readonly databaseId: string;
	/** Provides `Credentials | HttpClient` for `queryDatabase` (e.g. CredentialsFromEnv + FetchHttpClient.layer). */
	readonly layer: Layer.Layer<D1RestServices>;
}

/**
 * Build a `D1Database` over the REST API. `layer` must satisfy `queryDatabase`'s
 * `Credentials | HttpClient` requirement; the cast on the assembled object is the
 * single point widening the implemented slice to the full binding type — the same
 * idiom and justification as `apps/web/worker/db/sqlite-d1.testing.ts`.
 */
export const makeD1Rest = (config: D1RestConfig): D1Database => {
	const {accountId, databaseId, layer} = config;

	const runQuery = (request: Parameters<typeof d1.queryDatabase>[0]) =>
		Effect.runPromise(d1.queryDatabase(request).pipe(Effect.provide(layer)));

	const firstRows = async (sql: string, params: Params): Promise<Record<string, unknown>[]> => {
		const res = await runQuery({accountId, databaseId, sql, params: toRestParams(params)});
		return (res.result?.[0]?.results as Record<string, unknown>[]) ?? [];
	};

	const bound = (sql: string, params: Params): BoundStub => ({
		sql,
		params,
		all: async () => ({results: (await firstRows(sql, params)) as never[]}),
		// Carry D1's real row-change count into `meta.changes`: drizzle's `.run()` exposes
		// `result.meta.changes` (rows affected), and the REST `/query` response is
		// `result: [{ meta: { changes }, … }]`. Hardcoding `{}` here dropped it — latent
		// until a consumer reads it (it bit moderator-grant's setRole; #937/#940).
		run: async () => {
			const res = await runQuery({accountId, databaseId, sql, params: toRestParams(params)});
			return {success: true, meta: {changes: res.result?.[0]?.meta?.changes ?? 0}, results: []};
		},
		raw: async () => {
			const rows = await firstRows(sql, params);
			return rows.map((r) => Object.values(r)) as never[];
		},
		first: async () => ((await firstRows(sql, params))[0] as never) ?? null,
	});

	const prepare = (sql: string): PreparedStub => ({
		...bound(sql, []),
		bind: (...params: Params) => bound(sql, params),
	});

	// biome-ignore lint/plugin: only the prepare/exec/batch slice drizzle-orm/d1 calls is implemented; the full `D1Database` surface can't be built honestly here, so this assembly point widens to it once (same idiom as apps/web/worker/db/sqlite-d1.testing.ts).
	return {
		prepare,
		exec: async (sql: string) => {
			await runQuery({accountId, databaseId, sql});
			return {count: 0, duration: 0};
		},
		// One atomic REST `batch`: every drizzle statement's sql+params in a single
		// transaction (all-or-none), not N independent calls.
		batch: async (statements: BoundStub[]) => {
			await runQuery({
				accountId,
				databaseId,
				batch: statements.map((s) => ({sql: s.sql, params: toRestParams(s.params)})),
			});
			return statements.map(() => ({success: true, meta: {}, results: []}));
		},
		dump: async () => new ArrayBuffer(0),
	} as unknown as D1Database;
};

/**
 * The standard REST layer a bin runs the transport on: `CredentialsFromEnv`
 * (reads `$CLOUDFLARE_API_TOKEN`) + a Fetch HTTP client. Exposed so a caller
 * pointing at a known D1 (a bin, an integration test) builds the adapter the
 * exact same way, rather than re-assembling the credential/transport stack.
 */
export const d1RestLayerFromEnv: Layer.Layer<D1RestServices> = Layer.merge(
	CredentialsFromEnv,
	FetchHttpClient.layer,
);

/**
 * `makeD1Rest` over the env-credentialed REST layer — the one path a bin and its
 * integration test both run the real direct-D1 work through, so neither hand-rolls
 * the credential wiring (`$CLOUDFLARE_API_TOKEN` via `CredentialsFromEnv`).
 */
export const makeD1RestFromEnv = (target: {accountId: string; databaseId: string}): D1Database =>
	makeD1Rest({...target, layer: d1RestLayerFromEnv});

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ReadYourWriteOptions {
	/** Max poll attempts, counting the first read (default 6). */
	readonly maxAttempts?: number;
	/** Base of the exponential backoff, in ms (default 100). */
	readonly baseDelayMs?: number;
	/** Injected for tests — real `setTimeout` sleep by default. */
	readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Bounded read-your-writes poll for a read issued through {@link makeD1Rest}.
 *
 * The REST transport has NO read-your-writes guarantee: each statement is an independent
 * `queryDatabase` POST to `/d1/database/<id>/query`, and that endpoint neither accepts nor
 * returns a D1 session bookmark — `@distilled.cloud/cloudflare`'s `QueryDatabaseRequest` carries
 * only `sql`/`params`/`batch` (verified against the pinned SDK schema, itself generated from
 * Cloudflare's OpenAPI). D1's Sessions API commit token — the read-your-writes primitive — is
 * reachable only through the Workers binding (`env.DB.withSession()`), not this REST path. So a
 * REST read issued immediately after a REST write has no ordering against it and can observe the
 * pre-write state until the account's D1 fabric catches up (the #3075 künye flake).
 *
 * A caller that KNOWS the post-write truth (a test that just minted a row) passes it as
 * `isConsistent`; this re-reads with exponential backoff until the read reflects it or the attempt
 * budget is spent, and returns the LAST value either way — it never throws and never fabricates a
 * result, so the caller's own assertion on the returned value still fails loudly on a
 * genuinely-wrong read and only a not-yet-visible write is waited out. The transport itself cannot
 * do this: it cannot tell an absent row from a not-yet-visible one, so the expected state must come
 * from the caller — which is why this is a caller-invoked helper, not a transport auto-retry.
 */
export const readYourWrite = async <T>(
	read: () => Promise<T>,
	isConsistent: (value: T) => boolean,
	options: ReadYourWriteOptions = {},
): Promise<T> => {
	const {maxAttempts = 6, baseDelayMs = 100, sleep = defaultSleep} = options;
	let value = await read();
	for (let attempt = 1; attempt < maxAttempts && !isConsistent(value); attempt++) {
		await sleep(baseDelayMs * 2 ** (attempt - 1));
		value = await read();
	}
	return value;
};
