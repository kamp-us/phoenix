/**
 * The test-account provisioner's four refusable facts: a token weak enough to be guessed, a target
 * whose name is not a per-PR preview's, a run naming no tier at all, and a standing whose tier this
 * run does not seed. Each must be decided BEFORE any write, so the fake below records every
 * statement it is handed and the assertions read that record.
 */

import {assert, describe, it} from "@effect/vitest";
import {toRestParams} from "@kampus/d1-rest";
import {
	type CaylakStanding,
	isThrowawayDatabaseName,
	KEFIL_SUFFIX,
	MIN_SESSION_TOKEN_LEN,
	makeTestAccountDb,
	parseSessionToken,
	parseStanding,
	provisionTestAccounts,
	SESSION_TTL_MS,
	TEST_ACCOUNTS,
} from "./test-account.ts";

/** A per-PR preview's real shape: alchemy's `phoenix-phoenix-db-pr-<n>-<hash>` (PR #7717's). */
const PREVIEW_NAME = "phoenix-phoenix-db-pr-7717-td6ketak4e75f6i4";
const PROD_NAME = "phoenix-phoenix-db-prod-9f2c1a7be4d05613";

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

const CAYLAK_TOKEN = parseSessionToken("c".repeat(MIN_SESSION_TOKEN_LEN));

/** The two forks of the promotion path, the pair a reviewer re-seeds between to capture both. */
const VOUCHED = parseStanding(`15${KEFIL_SUFFIX}`) as CaylakStanding;
const UNVOUCHED = parseStanding("0") as CaylakStanding;

describe("parseStanding", () => {
	it("reads a bare karma total as an unvouched standing", () => {
		assert.deepStrictEqual(parseStanding(" 15 "), {karma: 15, kefil: false});
	});

	it("reads the kefil suffix as the vouched fork", () => {
		assert.deepStrictEqual(parseStanding(`15${KEFIL_SUFFIX}`), {karma: 15, kefil: true});
		assert.deepStrictEqual(parseStanding(`0${KEFIL_SUFFIX}`), {karma: 0, kefil: true});
	});

	it("refuses anything that is not a point on the ladder", () => {
		for (const spec of ["", "-1", "1.5", "kefil", "15+", "15 kefil", "15+KEFIL", "abc"]) {
			assert.isNull(parseStanding(spec), `parseStanding(${JSON.stringify(spec)}) should refuse`);
		}
	});
});

describe("isThrowawayDatabaseName", () => {
	it("admits a per-PR preview and refuses production, a named stage and an empty name", () => {
		assert.isTrue(isThrowawayDatabaseName(PREVIEW_NAME));
		assert.isFalse(isThrowawayDatabaseName(PROD_NAME));
		assert.isFalse(isThrowawayDatabaseName("phoenix-phoenix-db-umut-2f1c9de4ab7705ff"));
		assert.isFalse(isThrowawayDatabaseName(""));
	});
});

describe("provisionTestAccounts", () => {
	/**
	 * The fence's whole job: a real database is refused on its name, and the tokens it was handed
	 * never get it past that — production carries no `-pr-` segment however the run is invoked.
	 */
	it("refuses a production database on its name, writing nothing", async () => {
		assert.isNotNull(TOKEN);
		const {d1, batched, selected} = fakeD1([]);
		const outcome = await provisionTestAccounts(makeTestAccountDb(d1), PROD_NAME, {yazar: TOKEN});
		assert.strictEqual(outcome._tag, "NotThrowaway");
		assert.strictEqual(outcome._tag === "NotThrowaway" ? outcome.databaseName : "", PROD_NAME);
		assert.lengthOf(batched, 0);
		assert.lengthOf(selected, 0);
	});

	/**
	 * The failure that put the fence on the name (#7740): CI's e2e suite signs human users up on
	 * every preview it tests, so a preview holding accounts is the normal case, not a refusable one.
	 */
	it("provisions a preview that already holds signed-up human accounts", async () => {
		assert.isNotNull(TOKEN);
		const {d1, batched} = fakeD1([{id: "e2e-signup-1"}, {id: "e2e-signup-2"}]);
		const outcome = await provisionTestAccounts(makeTestAccountDb(d1), PREVIEW_NAME, {
			yazar: TOKEN,
		});
		assert.strictEqual(outcome._tag, "Provisioned");
		assert.lengthOf(batched, 3);
	});

	it("names no tier rather than falling back to one when no token is supplied", async () => {
		const {d1, batched, selected} = fakeD1([]);
		const outcome = await provisionTestAccounts(makeTestAccountDb(d1), PREVIEW_NAME, {});
		assert.strictEqual(outcome._tag, "NoCredentials");
		assert.lengthOf(batched, 0);
		assert.lengthOf(selected, 0);
	});

	it("provisions account, session and moderates tuple in one batch on an empty database", async () => {
		assert.isNotNull(TOKEN);
		const now = new Date("2026-08-28T00:00:00.000Z");
		const {d1, batched} = fakeD1([]);
		const outcome = await provisionTestAccounts(
			makeTestAccountDb(d1),
			PREVIEW_NAME,
			{yazar: TOKEN},
			null,
			now,
		);
		assert.strictEqual(outcome._tag, "Provisioned");
		if (outcome._tag !== "Provisioned") return;
		assert.strictEqual(outcome.report.expiresAt.getTime(), now.getTime() + SESSION_TTL_MS);
		assert.deepStrictEqual(outcome.report.tiers, ["yazar"]);
		assert.lengthOf(batched, 3);
		assert.include(batched[0]?.sql ?? "", '"user"');
		assert.include(batched[1]?.sql ?? "", '"session"');
		assert.include(batched[2]?.sql ?? "", "relation_tuple");
		assert.include(batched[1]?.params ?? [], TOKEN);
		assert.include(batched[2]?.params ?? [], TEST_ACCOUNTS.yazar.id);
	});

	/**
	 * The çaylak carries no `moderates` tuple, and that is the point of the tier: an identity with
	 * moderation authority renders a moderator's affordances whatever its `tier` column says.
	 */
	it("gives each tier its own account + session, and the tuple only to the moderating one", async () => {
		assert.isNotNull(TOKEN);
		assert.isNotNull(CAYLAK_TOKEN);
		const {d1, batched} = fakeD1([]);
		const outcome = await provisionTestAccounts(makeTestAccountDb(d1), PREVIEW_NAME, {
			yazar: TOKEN,
			çaylak: CAYLAK_TOKEN,
		});
		assert.strictEqual(outcome._tag, "Provisioned");
		if (outcome._tag !== "Provisioned") return;
		assert.deepStrictEqual(outcome.report.tiers, ["yazar", "çaylak"]);
		assert.lengthOf(batched, 5);
		assert.include(batched[2]?.params ?? [], TEST_ACCOUNTS.çaylak.id);
		assert.include(batched[3]?.params ?? [], CAYLAK_TOKEN);
		assert.include(batched[4]?.sql ?? "", "relation_tuple");
		assert.include(batched[4]?.params ?? [], TEST_ACCOUNTS.yazar.id);
		assert.notInclude(
			batched.flatMap((stmt) => (stmt.sql.includes("relation_tuple") ? stmt.params : [])),
			TEST_ACCOUNTS.çaylak.id,
		);
	});

	it("seeds only the tier it holds a token for, leaving the other unwritten", async () => {
		assert.isNotNull(CAYLAK_TOKEN);
		const {d1, batched} = fakeD1([]);
		const outcome = await provisionTestAccounts(makeTestAccountDb(d1), PREVIEW_NAME, {
			çaylak: CAYLAK_TOKEN,
		});
		assert.strictEqual(outcome._tag, "Provisioned");
		if (outcome._tag !== "Provisioned") return;
		assert.deepStrictEqual(outcome.report.tiers, ["çaylak"]);
		assert.strictEqual(outcome.report.tuples, 0);
		assert.lengthOf(batched, 2);
		assert.notInclude(
			batched.flatMap((stmt) => stmt.params),
			TEST_ACCOUNTS.yazar.id,
		);
	});

	it("binds no null param — D1 REST rejects one and the batch would die mid-provision (#569)", async () => {
		assert.isNotNull(TOKEN);
		assert.isNotNull(CAYLAK_TOKEN);
		const {d1, batched} = fakeD1([]);
		await provisionTestAccounts(makeTestAccountDb(d1), PREVIEW_NAME, {
			yazar: TOKEN,
			çaylak: CAYLAK_TOKEN,
		});
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

const sqlOf = (batched: ReadonlyArray<Recorded>) => batched.map((stmt) => stmt.sql).join("\n");

describe("provisionTestAccounts — çaylak standing", () => {
	it("writes profile karma and a vouch in the same batch as the accounts", async () => {
		assert.isNotNull(TOKEN);
		assert.isNotNull(CAYLAK_TOKEN);
		const now = new Date("2026-09-03T00:00:00.000Z");
		const {d1, batched} = fakeD1([]);
		const outcome = await provisionTestAccounts(
			makeTestAccountDb(d1),
			PREVIEW_NAME,
			{yazar: TOKEN, çaylak: CAYLAK_TOKEN},
			VOUCHED,
			now,
		);
		assert.strictEqual(outcome._tag, "Provisioned");
		// 2 accounts × (user + session), then profile + vouch, then the yazar's moderates tuple.
		assert.lengthOf(batched, 7);
		assert.include(batched[4]?.sql ?? "", "user_profile");
		assert.include(batched[4]?.params ?? [], VOUCHED.karma);
		assert.include(batched[4]?.params ?? [], TEST_ACCOUNTS.çaylak.id);
		assert.include(batched[5]?.sql ?? "", "authorship_vouch");
		assert.include(batched[5]?.params ?? [], TEST_ACCOUNTS.yazar.id);
		assert.include(batched[5]?.params ?? [], TEST_ACCOUNTS.çaylak.id);
		assert.include(batched[6]?.sql ?? "", "relation_tuple");
	});

	/**
	 * The re-seed route is how a reviewer reaches the other fork of the promotion path, so the
	 * unvouched run must actively clear the vouch the vouched run wrote — leaving it would render
	 * the state the operator just asked to leave.
	 */
	it("sets karma rather than incrementing it, and deletes the vouch when the kefil is dropped", async () => {
		assert.isNotNull(CAYLAK_TOKEN);
		const {d1, batched} = fakeD1([]);
		const outcome = await provisionTestAccounts(
			makeTestAccountDb(d1),
			PREVIEW_NAME,
			{çaylak: CAYLAK_TOKEN},
			UNVOUCHED,
		);
		assert.strictEqual(outcome._tag, "Provisioned");
		assert.lengthOf(batched, 4);
		const profile = batched[2]?.sql ?? "";
		assert.include(profile, "user_profile");
		assert.match(profile, /on conflict .* do update set/i);
		assert.notInclude(profile, "+", "karma is set from a bound value, never incremented");
		assert.include(batched[2]?.params ?? [], UNVOUCHED.karma);
		assert.match(batched[3]?.sql ?? "", /^delete from "authorship_vouch"/i);
		assert.include(batched[3]?.params ?? [], TEST_ACCOUNTS.çaylak.id);
	});

	it("refuses a vouched standing when the yazar tier is unseeded, writing nothing", async () => {
		assert.isNotNull(CAYLAK_TOKEN);
		const {d1, batched, selected} = fakeD1([]);
		const outcome = await provisionTestAccounts(
			makeTestAccountDb(d1),
			PREVIEW_NAME,
			{çaylak: CAYLAK_TOKEN},
			VOUCHED,
		);
		assert.strictEqual(outcome._tag, "StandingNeedsTier");
		if (outcome._tag !== "StandingNeedsTier") return;
		assert.strictEqual(outcome.missing, "yazar");
		assert.strictEqual(outcome.role, "voucher");
		assert.lengthOf(batched, 0);
		assert.lengthOf(selected, 0);
	});

	it("refuses any standing when the çaylak tier itself is unseeded", async () => {
		assert.isNotNull(TOKEN);
		const {d1, batched} = fakeD1([]);
		const outcome = await provisionTestAccounts(
			makeTestAccountDb(d1),
			PREVIEW_NAME,
			{yazar: TOKEN},
			UNVOUCHED,
		);
		assert.strictEqual(outcome._tag, "StandingNeedsTier");
		if (outcome._tag !== "StandingNeedsTier") return;
		assert.strictEqual(outcome.missing, "çaylak");
		assert.strictEqual(outcome.role, "candidate");
		assert.lengthOf(batched, 0);
	});

	/** The name fence outranks the standing: a real target refuses before either is looked at. */
	it("refuses a standing on a database whose name is not a preview's", async () => {
		assert.isNotNull(CAYLAK_TOKEN);
		const {d1, batched} = fakeD1([]);
		const outcome = await provisionTestAccounts(
			makeTestAccountDb(d1),
			PROD_NAME,
			{çaylak: CAYLAK_TOKEN},
			VOUCHED,
		);
		assert.strictEqual(outcome._tag, "NotThrowaway");
		assert.lengthOf(batched, 0);
	});

	it("provisions exactly today's rows when no standing is named", async () => {
		assert.isNotNull(TOKEN);
		assert.isNotNull(CAYLAK_TOKEN);
		const credentials = {yazar: TOKEN, çaylak: CAYLAK_TOKEN};
		const now = new Date("2026-09-03T00:00:00.000Z");
		const {d1, batched} = fakeD1([]);
		const outcome = await provisionTestAccounts(
			makeTestAccountDb(d1),
			PREVIEW_NAME,
			credentials,
			null,
			now,
		);
		assert.strictEqual(outcome._tag, "Provisioned");
		if (outcome._tag !== "Provisioned") return;
		assert.deepStrictEqual(outcome.report, {
			tiers: ["yazar", "çaylak"],
			tuples: 1,
			expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
		});
		assert.lengthOf(batched, 5);
		assert.notInclude(sqlOf(batched), "user_profile");
		assert.notInclude(sqlOf(batched), "authorship_vouch");
	});

	/**
	 * The fence is the database's name (ADR 0349), so a seeded standing cannot move it either way —
	 * the provisioner reads no row at all, whatever standing it was handed.
	 */
	it("reads nothing off the target to seed a standing", async () => {
		assert.isNotNull(TOKEN);
		assert.isNotNull(CAYLAK_TOKEN);
		const {d1, selected} = fakeD1([]);
		const outcome = await provisionTestAccounts(
			makeTestAccountDb(d1),
			PREVIEW_NAME,
			{yazar: TOKEN, çaylak: CAYLAK_TOKEN},
			VOUCHED,
		);
		assert.strictEqual(outcome._tag, "Provisioned");
		assert.lengthOf(selected, 0);
	});
});
