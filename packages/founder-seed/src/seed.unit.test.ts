/**
 * The founder seed's pure core, asserted without a DB (ADR 0082 unit tier): the
 * empty-cohort no-op short-circuits before any binding call, and the stored ranks and
 * tuple key are the bytes the worker reads. Whether the writes mint exactly the cohort
 * once and no-op on a re-run is only-wrong-if-the-DB-differs, so it lives in the
 * `integration` tier on real D1 (`tests/integration/seed.test.ts`).
 */
import {drizzle} from "drizzle-orm/d1";
import {defineRelations} from "drizzle-orm/relations";
import {assert, describe, it} from "vitest";
import {seedSchema as schema} from "./schema.ts";
import {FOUNDER_ROLE, FOUNDER_TIER, MODERATES, PLATFORM, seedFounders} from "./seed.ts";

// An inert `D1Database`: any binding call on it throws, so the no-op row proves the
// short-circuit touches nothing.
// biome-ignore lint/plugin: a no-op stand-in can't be structurally typed as the full `D1Database` interface; nothing here calls a binding method.
const inertD1 = {} as unknown as D1Database;
const db = drizzle(inertD1, {relations: defineRelations(schema)});

describe("an empty cohort is a clean no-op (short-circuits before any DB call)", () => {
	it("returns all-zero counts without touching the binding", async () => {
		const res = await seedFounders(db, []);
		assert.deepStrictEqual(res, {cohort: 0, matched: 0, promoted: 0, inserted: 0});
	});
});

describe("the founder seed writes the ranks and tuple the worker reads", () => {
	it("the target ranks are exactly the ladder tops — moderator / yazar", () => {
		assert.strictEqual(FOUNDER_ROLE, "moderator");
		assert.strictEqual(FOUNDER_TIER, "yazar");
	});

	it("the grant constants are exactly moderates / key(platform) — the canonical write key", () => {
		assert.strictEqual(MODERATES, "moderates");
		assert.strictEqual(PLATFORM, "platform:platform");
	});
});
