/**
 * grant statement-building — the pure core, asserted without a DB (ADR 0082 unit
 * tier). The assign/revoke/list statements resolve their SQL+params via drizzle's
 * `.toSQL()` with no session call, so these pin the statement shape (the INSERT mints
 * exactly `(subject, "admin", key(platform))` with `onConflictDoNothing`; revoke
 * deletes keyed on the composite; list filters the `admin`-over-platform tuples)
 * without booting a SQL engine. Plus the key-encoding contract: `PLATFORM` is the
 * canonical `key(platform)` (`"platform:platform"`), the SAME string the worker read
 * uses — the write→read alignment a single-side test can otherwise miss. Whether the
 * INSERT actually lands a row, resolves a username, and reads back through `listAdmins`
 * is only-wrong-if-the-DB-differs — those live in the `integration` tier on real D1
 * (`tests/integration/grant.test.ts`).
 */
import {and, eq, sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {assert, describe, it} from "vitest";
import {ADMIN, PLATFORM} from "./grant.ts";
import {grantSchema as schema} from "./schema.ts";

// An inert `D1Database`: drizzle's query builders resolve SQL+params via `.toSQL()`
// with no session call, so no binding method is ever invoked (the unit-tier "no SQL
// engine" shape — same idiom as moderator-grant's `grant.unit.test.ts`).
// biome-ignore lint/plugin: a no-op stand-in (statement-building never touches the binding) can't be structurally typed as the full `D1Database` interface; nothing here calls a binding method.
const inertD1 = {} as unknown as D1Database;
const db = drizzle(inertD1, {schema});

describe("the admin grant is keyed on the canonical platform node", () => {
	it("ADMIN is the `admin` relation and PLATFORM is key(platform) = 'platform:platform'", () => {
		assert.strictEqual(ADMIN, "admin");
		// The write key MUST equal the worker read key (`RelationStoreLive` over `key(platform)`),
		// else a granted admin is denied — the divergence the integration seam guards end to end.
		assert.strictEqual(PLATFORM, "platform:platform");
	});
});

describe("assignAdmin — the INSERT mints (subject, 'admin', key(platform)), idempotent", () => {
	it("inserts the admin tuple with onConflictDoNothing", () => {
		const {sql: text, params} = db
			.insert(schema.relationTuple)
			.values({subject: "u-alice", relation: ADMIN, object: PLATFORM})
			.onConflictDoNothing()
			.toSQL();
		assert.match(text, /insert into "relation_tuple"/i);
		assert.match(text, /on conflict do nothing/i);
		assert.include(params as unknown[], "u-alice");
		assert.include(params as unknown[], "admin");
		assert.include(params as unknown[], "platform:platform");
	});
});

describe("resolveSubject — the selector keys exactly one user column", () => {
	it("by username keys `username`, never widening to id", () => {
		const {sql: text, params} = db
			.select({id: schema.user.id})
			.from(schema.user)
			.where(eq(schema.user.username, "alice"))
			.toSQL();
		assert.match(text, /where "user"\."username" = \?/i);
		assert.notMatch(text, /"id" = \?/i);
		assert.include(params as unknown[], "alice");
	});

	it("by id keys `id` (the alternate selector), not username", () => {
		const {sql: text, params} = db
			.select({id: schema.user.id})
			.from(schema.user)
			.where(eq(schema.user.id, "u-bob"))
			.toSQL();
		assert.match(text, /where "user"\."id" = \?/i);
		assert.notMatch(text, /"username" = \?/i);
		assert.include(params as unknown[], "u-bob");
	});
});

describe("revokeAdmin — the DELETE keys the full admin tuple", () => {
	it("deletes WHERE subject = ? AND relation = 'admin' AND object = key(platform)", () => {
		const {sql: text, params} = db
			.delete(schema.relationTuple)
			.where(
				and(
					eq(schema.relationTuple.subject, "u-alice"),
					eq(schema.relationTuple.relation, ADMIN),
					eq(schema.relationTuple.object, PLATFORM),
				),
			)
			.toSQL();
		assert.match(text, /delete from "relation_tuple"/i);
		assert.match(text, /"subject" = \?/i);
		assert.include(params as unknown[], "u-alice");
		assert.include(params as unknown[], "admin");
		assert.include(params as unknown[], "platform:platform");
	});
});

describe("listAdmins — the audit read filters relation + object, orders by subject", () => {
	it("selects subject WHERE relation='admin' AND object=key(platform) ORDER BY subject ASC", () => {
		const {sql: text, params} = db
			.select({subject: schema.relationTuple.subject})
			.from(schema.relationTuple)
			.where(
				and(eq(schema.relationTuple.relation, ADMIN), eq(schema.relationTuple.object, PLATFORM)),
			)
			.orderBy(sql`${schema.relationTuple.subject} ASC`)
			.toSQL();
		assert.match(text, /select .*"subject".* from "relation_tuple"/i);
		assert.match(text, /order by "relation_tuple"\."subject" asc/i);
		assert.include(params as unknown[], "admin");
		assert.include(params as unknown[], "platform:platform");
	});
});
