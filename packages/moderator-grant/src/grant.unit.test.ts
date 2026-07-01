/**
 * grant statement-building — the pure core, asserted without a DB (ADR 0082 unit
 * tier). `setRole`/`listModerators` resolve their SQL+params via drizzle's `.toSQL()`
 * with no session call, so these pin the statement shape (the selector keys exactly
 * one column; the update sets `role`; the list filters on `role='moderator'` and
 * orders by username) without booting a SQL engine. Whether the UPDATE actually flips
 * a real row, is selectable by id OR username, reports a distinct changed-count, and
 * reads back through `listModerators` is only-wrong-if-the-DB-differs — those live in
 * the `integration` tier on real D1 (`tests/integration/grant.test.ts`).
 */
import {eq, sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {defineRelations} from "drizzle-orm/relations";
import {assert, describe, it} from "vitest";
import {grantSchema as schema} from "./schema.ts";

// An inert `D1Database`: drizzle's query builders resolve SQL+params via `.toSQL()`
// with no session call, so no binding method is ever invoked (the unit-tier "no SQL
// engine" shape — same idiom as preview-seed's `seed.unit.test.ts`).
// biome-ignore lint/plugin: a no-op stand-in (statement-building never touches the binding) can't be structurally typed as the full `D1Database` interface; nothing here calls a binding method.
const inertD1 = {} as unknown as D1Database;
const db = drizzle(inertD1, {relations: defineRelations(schema)});

describe("setRole — the UPDATE keys exactly the chosen selector, sets role", () => {
	it("by username keys `username` and sets role, never widening to id", () => {
		const {sql: text, params} = db
			.update(schema.user)
			.set({role: "moderator", updatedAt: new Date(0)})
			.where(eq(schema.user.username, "alice"))
			.toSQL();
		assert.match(text, /update .*"user".* set /i);
		assert.match(text, /"role" = \?/i);
		assert.match(text, /where "user"\."username" = \?/i);
		assert.notMatch(text, /"id"/i); // keyed on username, not id
		assert.include(params as unknown[], "alice");
		assert.include(params as unknown[], "moderator");
	});

	it("by id keys `id` (the alternate selector), not username", () => {
		const {sql: text, params} = db
			.update(schema.user)
			.set({role: "moderator", updatedAt: new Date(0)})
			.where(eq(schema.user.id, "u-bob"))
			.toSQL();
		assert.match(text, /where "user"\."id" = \?/i);
		assert.notMatch(text, /"username"/i);
		assert.include(params as unknown[], "u-bob");
	});

	it("revoke is the same UPDATE binding role = 'member'", () => {
		const {params} = db
			.update(schema.user)
			.set({role: "member", updatedAt: new Date(0)})
			.where(eq(schema.user.username, "alice"))
			.toSQL();
		assert.include(params as unknown[], "member");
	});
});

describe("listModerators — the audit read filters role + orders by username", () => {
	it("selects id+username WHERE role = 'moderator' ORDER BY username ASC", () => {
		const {sql: text, params} = db
			.select({id: schema.user.id, username: schema.user.username})
			.from(schema.user)
			.where(eq(schema.user.role, "moderator"))
			.orderBy(sql`${schema.user.username} ASC`)
			.toSQL();
		assert.match(text, /select .*"id".*"username".* from "user"/i);
		assert.match(text, /where "user"\."role" = \?/i);
		assert.match(text, /order by "user"\."username" asc/i);
		assert.include(params as unknown[], "moderator");
	});
});
