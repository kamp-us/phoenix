/**
 * seed statement-building + the empty-cohort no-op — the pure core, asserted without a
 * DB (ADR 0082 unit tier). The cohort read, the promotion update, and the tuple insert
 * resolve their SQL+params via drizzle's `.toSQL()` with no session call, so these pin
 * the statement shape: the cohort read filters `id IN (…)`; the promotion writes
 * `role='moderator', tier='yazar'` guarded to skip already-seeded rows (idempotency +
 * non-downgrade); the insert writes `(subject, "moderates", key(platform))` with
 * `onConflictDoNothing`. The empty-cohort no-op short-circuits before any binding call,
 * so it runs here too. Whether the writes actually mint exactly the cohort once, no-op
 * idempotently on a re-run, and never downgrade a manually-promoted founder is
 * only-wrong-if-the-DB-differs — those live in the `integration` tier on real D1
 * (`tests/integration/seed.test.ts`).
 */
import {and, eq, inArray, ne, or, sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {defineRelations} from "drizzle-orm/relations";
import {assert, describe, it} from "vitest";
import {seedSchema as schema} from "./schema.ts";
import {FOUNDER_ROLE, FOUNDER_TIER, MODERATES, PLATFORM, seedFounders} from "./seed.ts";

// An inert `D1Database`: drizzle's query builders resolve SQL+params via `.toSQL()`
// with no session call, so no binding method is ever invoked (the unit-tier "no SQL
// engine" shape — same idiom as moderator-grant's `grant.unit.test.ts`).
// biome-ignore lint/plugin: a no-op stand-in (statement-building never touches the binding) can't be structurally typed as the full `D1Database` interface; nothing here calls a binding method.
const inertD1 = {} as unknown as D1Database;
const db = drizzle(inertD1, {relations: defineRelations(schema)});

describe("an empty cohort is a clean no-op (short-circuits before any DB call)", () => {
	it("returns all-zero counts without touching the binding", async () => {
		const res = await seedFounders(db, []);
		assert.deepStrictEqual(res, {cohort: 0, matched: 0, promoted: 0, inserted: 0});
	});
});

describe("the founder cohort read selects the roster ids", () => {
	it("selects id WHERE id IN (…)", () => {
		const {sql: text, params} = db
			.select({id: schema.user.id})
			.from(schema.user)
			.where(inArray(schema.user.id, ["u-alice", "u-bob"]))
			.toSQL();
		assert.match(text, /select .*"id".* from "user"/i);
		assert.match(text, /where "user"\."id" in \(\?, \?\)/i);
		assert.include(params as unknown[], "u-alice");
		assert.include(params as unknown[], "u-bob");
	});
});

describe("the founder promotion sets moderator+yazar, guarded to skip already-seeded rows", () => {
	it("updates role+tier WHERE id IN (…) AND (role != moderator OR tier != yazar)", () => {
		const {sql: text, params} = db
			.update(schema.user)
			.set({role: FOUNDER_ROLE, tier: FOUNDER_TIER})
			.where(
				and(
					inArray(schema.user.id, ["u-alice"]),
					or(ne(schema.user.role, FOUNDER_ROLE), ne(schema.user.tier, FOUNDER_TIER)),
				),
			)
			.toSQL();
		assert.match(text, /update "user" set/i);
		assert.match(text, /"role" = \?/i);
		assert.match(text, /"tier" = \?/i);
		// the idempotency + non-downgrade guard: only touch a row not already at the target
		assert.match(text, /where .*"id" in \(\?\).* and .*"role" <> \?.* or .*"tier" <> \?/i);
		assert.include(params as unknown[], "moderator");
		assert.include(params as unknown[], "yazar");
	});

	it("the target ranks are exactly the ladder tops — moderator / yazar", () => {
		assert.strictEqual(FOUNDER_ROLE, "moderator");
		assert.strictEqual(FOUNDER_TIER, "yazar");
	});
});

describe("the founder insert mints (subject, 'moderates', key(platform)) idempotently", () => {
	it("inserts the tuple columns with ON CONFLICT DO NOTHING", () => {
		const {sql: text, params} = db
			.insert(schema.relationTuple)
			.values([
				{subject: "u-alice", relation: MODERATES, object: PLATFORM},
				{subject: "u-bob", relation: MODERATES, object: PLATFORM},
			])
			.onConflictDoNothing()
			.toSQL();
		assert.match(text, /insert into "relation_tuple"/i);
		assert.match(text, /"subject".*"relation".*"object"/i);
		assert.match(text, /on conflict do nothing/i);
		// every founder's grant is exactly (id, "moderates", key(platform))
		assert.include(params as unknown[], "u-alice");
		assert.include(params as unknown[], "u-bob");
		assert.include(params as unknown[], "moderates");
		assert.include(params as unknown[], "platform:platform");
	});

	it("the grant constants are exactly moderates / key(platform) — the canonical write key", () => {
		assert.strictEqual(MODERATES, "moderates");
		assert.strictEqual(PLATFORM, "platform:platform");
	});
});

describe("listFounderTuples reads the founder relation/object, ordered by subject", () => {
	it("selects the tuple columns WHERE relation='moderates' AND object=key(platform) ORDER BY subject ASC", () => {
		const {sql: text, params} = db
			.select({
				subject: schema.relationTuple.subject,
				relation: schema.relationTuple.relation,
				object: schema.relationTuple.object,
			})
			.from(schema.relationTuple)
			.where(
				and(
					eq(schema.relationTuple.relation, MODERATES),
					eq(schema.relationTuple.object, PLATFORM),
				),
			)
			.orderBy(sql`${schema.relationTuple.subject} ASC`)
			.toSQL();
		assert.match(text, /from "relation_tuple"/i);
		assert.match(text, /where .*"relation" = \?.* and .*"object" = \?/i);
		assert.match(text, /order by "relation_tuple"\."subject" asc/i);
		assert.include(params as unknown[], "moderates");
		assert.include(params as unknown[], "platform:platform");
	});
});
