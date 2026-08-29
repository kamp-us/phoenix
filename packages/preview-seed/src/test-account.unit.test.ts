/**
 * The test-account provisioner's two refusable facts: a token weak enough to be guessed, and a
 * target that is not a throwaway. Both must be decided BEFORE any write, so the fake below records
 * every statement it is handed and the assertions read that record.
 */

import {assert, describe, it} from "@effect/vitest";
import {toRestParams} from "@kampus/d1-rest";
import {
	MIN_SESSION_TOKEN_LEN,
	makeTestAccountDb,
	parseSessionToken,
	provisionTestAccount,
	SESSION_TTL_MS,
	TEST_ACCOUNT,
} from "./test-account.ts";

interface Recorded {
	readonly sql: string;
	readonly params: readonly unknown[];
}

/** A `D1Database` stand-in: `all()` serves the configured user rows, `batch()` records and reports. */
const fakeD1 = (users: ReadonlyArray<{id: string}>) => {
	const batched: Recorded[] = [];
	const selected: Recorded[] = [];
	const bound = (sql: string, params: readonly unknown[]) => ({
		sql,
		params,
		all: async () => {
			selected.push({sql, params});
			return {results: users};
		},
		run: async () => ({success: true as const, meta: {changes: 1}, results: []}),
		// drizzle's core select prepares in `arrays` mode, so a row reaches it through `raw()` as
		// positional values, never through `all()` — a fake that only serves `all()` reads empty.
		raw: async () => {
			selected.push({sql, params});
			return users.map((row) => Object.values(row));
		},
		first: async () => null,
	});
	const client = {
		prepare: (sql: string) => ({
			...bound(sql, []),
			bind: (...params: unknown[]) => bound(sql, params),
		}),
		batch: async (stmts: ReadonlyArray<Recorded>) => {
			for (const stmt of stmts) batched.push({sql: stmt.sql, params: stmt.params});
			return stmts.map(() => ({success: true as const, meta: {changes: 1}, results: []}));
		},
	};
	// biome-ignore lint/plugin: the stand-in implements only the slice drizzle-orm/d1 drives; the full `D1Database` interface is not structurally reachable here.
	return {d1: client as unknown as D1Database, batched, selected};
};

const TOKEN = parseSessionToken("t".repeat(MIN_SESSION_TOKEN_LEN));

describe("parseSessionToken", () => {
	it("refuses a token below the minimum length", () => {
		assert.isNull(parseSessionToken("t".repeat(MIN_SESSION_TOKEN_LEN - 1)));
	});

	it("refuses a token carrying a cookie-illegal character", () => {
		assert.isNull(parseSessionToken(`${"t".repeat(MIN_SESSION_TOKEN_LEN)};evil=1`));
		assert.isNull(parseSessionToken(`${"t".repeat(MIN_SESSION_TOKEN_LEN)} spaced`));
	});

	it("accepts a long token and trims it", () => {
		assert.strictEqual(parseSessionToken(`  ${"t".repeat(40)}  `), "t".repeat(40));
	});
});

describe("provisionTestAccount", () => {
	it("refuses a database holding a foreign account, writing nothing", async () => {
		assert.isNotNull(TOKEN);
		const {d1, batched} = fakeD1([{id: "somebody-real"}]);
		const outcome = await provisionTestAccount(makeTestAccountDb(d1), TOKEN);
		assert.strictEqual(outcome._tag, "NotThrowaway");
		assert.strictEqual(outcome._tag === "NotThrowaway" ? outcome.foreignAccounts : -1, 1);
		assert.lengthOf(batched, 0);
	});

	it("provisions account, session and moderates tuple in one batch on an empty database", async () => {
		assert.isNotNull(TOKEN);
		const now = new Date("2026-08-28T00:00:00.000Z");
		const {d1, batched} = fakeD1([]);
		const outcome = await provisionTestAccount(makeTestAccountDb(d1), TOKEN, now);
		assert.strictEqual(outcome._tag, "Provisioned");
		if (outcome._tag !== "Provisioned") return;
		assert.strictEqual(outcome.report.expiresAt.getTime(), now.getTime() + SESSION_TTL_MS);
		assert.lengthOf(batched, 3);
		assert.include(batched[0]?.sql ?? "", '"user"');
		assert.include(batched[1]?.sql ?? "", '"session"');
		assert.include(batched[2]?.sql ?? "", "relation_tuple");
		assert.include(batched[1]?.params ?? [], TOKEN);
		assert.include(batched[2]?.params ?? [], TEST_ACCOUNT.id);
	});

	it("binds no null param — D1 REST rejects one and the batch would die mid-provision (#569)", async () => {
		assert.isNotNull(TOKEN);
		const {d1, batched} = fakeD1([]);
		await provisionTestAccount(makeTestAccountDb(d1), TOKEN);
		batched.forEach((stmt, i) => {
			stmt.params.forEach((p, j) => {
				assert.isNotNull(p, `batch[${i}].params[${j}] is null`);
				assert.notTypeOf(p, "undefined", `batch[${i}].params[${j}] is undefined`);
			});
			toRestParams(stmt.params).forEach((w, j) => {
				assert.typeOf(w, "string", `batch[${i}] wire param[${j}] must be a string`);
			});
		});
	});
});
