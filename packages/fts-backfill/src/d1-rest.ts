/**
 * A `D1Database`-shaped binding backed by the Cloudflare D1 REST query API, so the
 * backfill's drizzle reads + FTS writes run from a plain Node process (no
 * workerd). Implements only the slice `drizzle-orm/d1` drives —
 * `prepare`/`bind`/`all`/`run`/`raw`/`first` and `batch` — the same adapter idiom
 * as `@kampus/preview-seed`'s `d1-rest.ts`.
 *
 * Transport is `@distilled.cloud/cloudflare`'s `queryDatabase` (already in the
 * tree via alchemy). A single statement is one REST call; a drizzle `batch([...])`
 * collects every statement's sql+params into ONE REST `batch` call, which D1 runs
 * as a single atomic transaction — load-bearing for the backfill's all-or-none
 * write. The adapter methods return Promises and run the `queryDatabase` Effect
 * with the provided credentials/HTTP layer per call.
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
 * REST `params` is typed `string[]`, but D1 binds a literal `null` as SQL NULL —
 * so a nullable drizzle column's `null` must reach the wire unstringified (else
 * it would bind the text "null"). The upstream type can't express that, so this
 * boundary widens to the runtime-accurate `(string | null)[]`.
 */
const toRestParams = (params: Params): string[] => {
	const out: Array<string | null> = params.map((p) => (p == null ? null : String(p)));
	return out as string[];
};

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
		run: async () => {
			await firstRows(sql, params);
			return {success: true, meta: {}, results: []};
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
 * The standard REST layer the bin runs the backfill on: `CredentialsFromEnv`
 * (reads `$CLOUDFLARE_API_TOKEN`) + a Fetch HTTP client. Exposed so a caller
 * pointing at a known D1 (the bin, an integration test) builds the adapter the
 * exact same way, rather than re-assembling the credential/transport stack.
 */
export const d1RestLayerFromEnv: Layer.Layer<D1RestServices> = Layer.merge(
	CredentialsFromEnv,
	FetchHttpClient.layer,
);

/**
 * `makeD1Rest` over the env-credentialed REST layer — the one path the bin and the
 * integration test both run the real backfill through, so neither hand-rolls the
 * credential wiring (`$CLOUDFLARE_API_TOKEN` via `CredentialsFromEnv`).
 */
export const makeD1RestFromEnv = (target: {accountId: string; databaseId: string}): D1Database =>
	makeD1Rest({...target, layer: d1RestLayerFromEnv});
