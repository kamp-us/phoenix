/**
 * A `D1Database`-shaped binding backed by the Cloudflare D1 REST query API, so
 * the seed's drizzle inserts run from a plain Node process (no workerd). It
 * implements only the slice `drizzle-orm/d1` drives — `prepare`/`bind`/`all`/
 * `run`/`raw`/`first` and `batch`. This is the seed's ONLY transport: both the
 * `preview-seed` bin and the integration tier (`tests/integration/_d1.ts`) run
 * the same `seed(d1)` path through it against real D1 (ADR 0082 — the package's
 * suite no longer leans on a faked engine).
 *
 * Transport is `@distilled.cloud/cloudflare`'s `queryDatabase` (already in the
 * tree via alchemy). A single statement is one REST call; a drizzle `batch([...])`
 * collects every statement's sql+params into ONE REST `batch` call, which D1 runs
 * as a single atomic transaction — load-bearing for the seed's all-or-none write.
 * The adapter methods return Promises and run the `queryDatabase` Effect with the
 * provided credentials/HTTP layer per call.
 */
import type {Credentials} from "@distilled.cloud/cloudflare/Credentials";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import type {Layer} from "effect";
import {Effect} from "effect";
import type {HttpClient} from "effect/unstable/http/HttpClient";

/** The services `queryDatabase` requires; the bin's layer must provide exactly these. */
export type D1RestServices = Credentials | HttpClient;

type Params = ReadonlyArray<unknown>;

/**
 * Assert one bound param satisfies D1's REST `params` contract.
 * `@distilled.cloud/cloudflare`'s `queryDatabase` validates `params` as a strict
 * `string[]` and **rejects a `null`/`undefined` element** (`SchemaError: Expected
 * string, got null`), so a SQL NULL must be rendered *inline* in the statement text
 * — never bound as a `null` param. The seed achieves that by leaving nullable
 * columns unset in its fixtures, so drizzle emits a literal `NULL` and no `null`
 * ever reaches the wire (#569). A `null`/`undefined` here is a caller bug (a
 * nullable column bound instead of omitted); throw with the offending index. The
 * unit tier pins this contract directly (`seed.unit.test.ts`) and the integration
 * tier proves real D1 rejects null end to end — so the param shape can't drift from
 * what the live REST wire accepts (#571).
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
