/**
 * The seed's built statements never bind a null (ADR 0082 unit tier). D1 REST validates
 * `params` as a strict `string[]` and rejects a `null`/`undefined` element, so the seed
 * died on a real D1 before writing anything when a nullable column was bound instead of
 * omitted (#569).
 */

import {assert, describe, it} from "@effect/vitest";
import {toRestParams} from "@kampus/d1-rest";
import {drizzle} from "drizzle-orm/d1";
import {buildSeedStatements, makeSeedDb} from "./seed.ts";

// Inert because drizzle resolves SQL+params via `.toSQL()` with no session call, so no
// binding method is ever invoked here.
// biome-ignore lint/plugin: a no-op stand-in (statement-building never touches the binding) can't be structurally typed as the full `D1Database` interface; nothing here calls a binding method.
const inertD1 = {} as unknown as D1Database;

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
