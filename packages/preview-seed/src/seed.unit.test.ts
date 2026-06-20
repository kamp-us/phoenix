/**
 * REST-wire param contract — the pure core, asserted without a DB (ADR 0082 unit
 * tier). `@distilled.cloud/cloudflare`'s `queryDatabase` validates D1 REST `params`
 * as a strict `string[]` and rejects a `null`/`undefined` element (`SchemaError:
 * Expected string, got null`), so the seed died on a real D1 before writing anything
 * when a nullable column was bound instead of omitted (#569). These assertions pin
 * that contract at the two seams that enforce it (`assertRestParam` / `toRestParams`,
 * `d1-rest.ts`) and that the seed's built statements never bind a null — none of
 * which needs a SQL engine to be true: statement-building and the param transform are
 * pure (`SeedDb.<builder>.toSQL()` resolves the SQL+params without touching the
 * binding). The faithful end-to-end proof that real D1 rejects null lives on the
 * production REST path, exercised by the integration tier.
 */

import {fromApiToken} from "@distilled.cloud/cloudflare/Credentials";
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Layer} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {assertRestParam, makeD1Rest, toRestParams} from "./d1-rest.ts";
import {buildSeedStatements, makeSeedDb} from "./seed.ts";

// An inert `D1Database` for building statements only: drizzle's query builders resolve
// their SQL+params via `.toSQL()` with no session call, so no binding method is ever
// invoked here — the unit-tier "no SQL engine" shape (same idiom as
// apps/web/worker/features/search/fts-sync.unit.test.ts's recording client).
// biome-ignore lint/plugin: a no-op stand-in (statement-building never touches the binding) can't be structurally typed as the full `D1Database` interface; nothing here calls a binding method.
const inertD1 = {} as unknown as D1Database;

describe("toRestParams / assertRestParam — D1 REST rejects null params (#569)", () => {
	it("rejects a null or undefined bound param with the wire-contract message", () => {
		for (const bad of [null, undefined]) {
			assert.throws(
				() => assertRestParam(bad, 0),
				/strict string\[\] and rejects null/,
				`binding ${bad} must throw`,
			);
			assert.throws(() => toRestParams([bad]), /strict string\[\] and rejects null/);
		}
	});

	it("stringifies a non-null param the REST client accepts (numbers, strings, booleans)", () => {
		assert.deepStrictEqual(toRestParams([42, "x", true]), ["42", "x", "true"]);
	});
});

describe("buildSeedStatements — no statement binds a null/undefined param", () => {
	it("every built statement's params are null-free and survive toRestParams", () => {
		const {statements} = buildSeedStatements(makeSeedDb(inertD1));
		assert.isAtLeast(statements.length, 1);
		statements.forEach((stmt, i) => {
			const {params} = stmt.toSQL();
			params.forEach((p, j) => {
				assert.isNotNull(p, `batch[${i}].params[${j}] is null — D1 REST params is strict string[]`);
				assert.notTypeOf(p, "undefined", `batch[${i}].params[${j}] is undefined`);
			});
			// toRestParams is the exact REST-wire transform; it must yield a clean string[].
			toRestParams(params).forEach((w, j) => {
				assert.typeOf(w, "string", `batch[${i}] wire param[${j}] must be a string`);
			});
		});
	});
});

// Guard the inert-binding assumption: if a future drizzle/d1 change made statement
// building touch the session, this would throw here (not silently mis-test).
describe("buildSeedStatements — statement building needs no live binding", () => {
	it("resolves SQL + params from a no-op D1 stand-in", () => {
		const {statements} = buildSeedStatements(drizzle(inertD1));
		assert.isAtLeast(statements.length, 1);
		assert.isString(statements[0]?.toSQL().sql);
	});
});

// #940: `run()` once hardcoded `meta: {}`, dropping D1's row-change count — latent in the
// seed (no consumer reads it) but it bit moderator-grant's setRole (#937). Lock the REST
// `result: [{ meta: { changes } }]` → `meta.changes` mapping so it can't regress, driving
// the real REST adapter offline over a fake Fetch (no CF creds).
describe("makeD1Rest — run() carries D1's row-change count (#937/#940)", () => {
	const restD1 = (fetch: typeof globalThis.fetch) =>
		makeD1Rest({
			accountId: "acc",
			databaseId: "db",
			layer: Layer.mergeAll(
				FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fetch))),
				fromApiToken({apiToken: "test-token"}),
			),
		});

	const respond =
		(result: unknown): typeof globalThis.fetch =>
		async () =>
			new Response(JSON.stringify({result}), {
				status: 200,
				headers: {"content-type": "application/json"},
			});

	it("maps result[0].meta.changes from the REST response", async () => {
		const d1 = restD1(respond([{meta: {changes: 3}, results: [], success: true}]));
		const res = await d1.prepare("update x set y = ? where z = ?").bind("a", "b").run();
		assert.strictEqual(res.meta.changes, 3);
	});

	it("defaults meta.changes to 0 when the response carries none", async () => {
		const d1 = restD1(respond([{results: [], success: true}]));
		const res = await d1.prepare("update x set y = ? where z = ?").bind("a", "b").run();
		assert.strictEqual(res.meta.changes, 0);
	});
});
