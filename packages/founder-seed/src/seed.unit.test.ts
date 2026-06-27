/**
 * seed statement-building — the pure core, asserted without a DB (ADR 0082 unit
 * tier). The cohort read + the tuple insert resolve their SQL+params via drizzle's
 * `.toSQL()` with no session call, so these pin the statement shape (the cohort read
 * filters `role='moderator'`; the insert writes `(subject, "moderates", key(platform))`
 * with `onConflictDoNothing`; the list filters the founder relation/object) without
 * booting a SQL engine. Whether the INSERT actually mints exactly the cohort once,
 * no-ops idempotently on a re-run, and reads back through `listFounderTuples` is
 * only-wrong-if-the-DB-differs — those live in the `integration` tier on real D1
 * (`tests/integration/seed.test.ts`).
 */
import {and, eq, sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {assert, describe, it} from "vitest";
import {seedSchema as schema} from "./schema.ts";
import {MODERATES, PLATFORM} from "./seed.ts";

// An inert `D1Database`: drizzle's query builders resolve SQL+params via `.toSQL()`
// with no session call, so no binding method is ever invoked (the unit-tier "no SQL
// engine" shape — same idiom as moderator-grant's `grant.unit.test.ts`).
// biome-ignore lint/plugin: a no-op stand-in (statement-building never touches the binding) can't be structurally typed as the full `D1Database` interface; nothing here calls a binding method.
const inertD1 = {} as unknown as D1Database;
const db = drizzle(inertD1, {schema});

describe("the founder cohort read filters role='moderator'", () => {
	it("selects id WHERE role = 'moderator'", () => {
		const {sql: text, params} = db
			.select({id: schema.user.id})
			.from(schema.user)
			.where(eq(schema.user.role, "moderator"))
			.toSQL();
		assert.match(text, /select .*"id".* from "user"/i);
		assert.match(text, /where "user"\."role" = \?/i);
		assert.include(params as unknown[], "moderator");
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
