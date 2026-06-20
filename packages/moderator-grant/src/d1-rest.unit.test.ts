/**
 * REST-wire param contract — the pure core, asserted without a DB (ADR 0082 unit
 * tier). `@distilled.cloud/cloudflare`'s `queryDatabase` validates D1 REST `params`
 * as a strict `string[]` and rejects a `null`/`undefined` element (`SchemaError:
 * Expected string, got null`), so a nullable column bound instead of omitted dies on
 * real D1 before any write (#569). These pin that contract at the two seams that
 * enforce it (`assertRestParam` / `toRestParams`, `d1-rest.ts`) — neither needs a SQL
 * engine to be true. The faithful proof that real D1 actually flips a row lives on the
 * production REST path, exercised by the integration tier.
 */
import {assert, describe, it} from "@effect/vitest";
import {assertRestParam, toRestParams} from "./d1-rest.ts";

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
