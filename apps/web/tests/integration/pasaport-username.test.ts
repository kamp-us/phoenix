/**
 * Username bootstrap integration test — D1-direct path (task_3, d1-direct).
 *
 * Exercises the resolver-side path end-to-end inside workerd:
 *   1. Apply the D1 schema (including the new auth tables in migration 0004).
 *   2. Seed a Pasaport user via better-auth's sign-up handler driven through
 *      the worker's `/api/auth/sign-up/email` route.
 *   3. Call the module-level `setUsername(env, userId, value)` function and
 *      verify validation, uniqueness, immutability, and that the
 *      `user_profile` row lands in the same D1 transaction.
 *   4. Verify `backfillProfiles(env)` emits a `user_profile` row for users
 *      without usernames.
 *
 * No `env.PASAPORT.get(...)` stubs and no `runInDurableObject` — every assertion
 * runs against module functions writing PHOENIX_DB directly.
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:test";
import {beforeAll, describe, expect, it} from "vitest";
import {
	backfillProfiles,
	countUsersWithoutUsername,
	findUsername,
	handleAuth,
	setUsername,
} from "../../worker/features/pasaport/module";
import viewMigration0000 from "../../worker/db/drizzle/migrations/0000_secret_iron_patriot.sql";
import viewMigration0001 from "../../worker/db/drizzle/migrations/0001_free_salo.sql";
import viewMigration0002 from "../../worker/db/drizzle/migrations/0002_wandering_natasha_romanoff.sql";
import viewMigration0003 from "../../worker/db/drizzle/migrations/0003_lazy_thanos.sql";
import viewMigration0004 from "../../worker/db/drizzle/migrations/0004_brown_squadron_supreme.sql";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

async function applyViewMigrations() {
	const sources = [
		viewMigration0000,
		viewMigration0001,
		viewMigration0002,
		viewMigration0003,
		viewMigration0004,
	];
	for (const src of sources) {
		const statements = src
			.split("--> statement-breakpoint")
			.map((s: string) => s.trim())
			.filter(Boolean);
		for (const stmt of statements) {
			try {
				await env.PHOENIX_DB.prepare(stmt).run();
			} catch (err) {
				const msg = String(err);
				if (
					!msg.includes("already exists") &&
					!msg.includes("duplicate column") &&
					!msg.includes("no such table") &&
					!msg.includes("no such index")
				) {
					throw err;
				}
			}
		}
	}
}

/**
 * Drive better-auth via the worker-mounted `/api/auth/sign-up/email` route.
 * This is the canonical sign-up path the SPA uses, so exercising it confirms
 * the better-auth + D1 wiring works end-to-end. Returns the new user id.
 */
async function signUp(email: string, password: string, name: string): Promise<string> {
	const req = new Request("https://example.com/api/auth/sign-up/email", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({email, password, name}),
	});
	const response = await handleAuth(env, req);
	if (!response.ok) {
		throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
	}
	const data = (await response.json()) as {user?: {id: string}};
	if (!data.user?.id) throw new Error("sign-up returned no user id");
	return data.user.id;
}

beforeAll(async () => {
	await applyViewMigrations();
});

async function expectRejectionMessage(promise: Promise<unknown>, match: RegExp): Promise<void> {
	try {
		await promise;
		throw new Error("expected rejection");
	} catch (err) {
		expect((err as Error).message).toMatch(match);
	}
}

describe("pasaport.setUsername — bootstrap flow + user_profile (D1-direct)", () => {
	it("sets a username and lands a user_profile row with the unique handle", async () => {
		const userId = await signUp("elif@kamp.us", "supersecret123", "Elif Kaya");

		const result = await setUsername(env, {userId, value: "elif"});
		expect(result.username).toBe("elif");
		expect(result.userId).toBe(userId);

		// user_profile lands in the same D1 transaction as the user.username
		// update, so no convergence loop is needed.
		const row = await env.PHOENIX_DB.prepare(
			"SELECT user_id, username FROM user_profile WHERE username = ?",
		)
			.bind("elif")
			.first<{user_id: string; username: string}>();
		expect(row).not.toBeNull();
		expect(row!.user_id).toBe(userId);
		expect(row!.username).toBe("elif");
	});

	it("rejects invalid usernames", async () => {
		const userId = await signUp("a@kamp.us", "supersecret123", "A");

		await expectRejectionMessage(setUsername(env, {userId, value: "ab"}), /en az 3/);
		await expectRejectionMessage(
			setUsername(env, {userId, value: "a".repeat(31)}),
			/en fazla 30/,
		);
		await expectRejectionMessage(setUsername(env, {userId, value: "Bad Spaces"}), /küçük harf/);
		await expectRejectionMessage(setUsername(env, {userId, value: "-leading"}), /küçük harf/);
		await expectRejectionMessage(setUsername(env, {userId, value: "trailing-"}), /küçük harf/);
	});

	it("rejects duplicate usernames", async () => {
		const u1 = await signUp("first@kamp.us", "supersecret123", "First");
		const u2 = await signUp("second@kamp.us", "supersecret123", "Second");

		await setUsername(env, {userId: u1, value: "umut"});
		await expectRejectionMessage(setUsername(env, {userId: u2, value: "umut"}), /kullanımda/);
	});

	it("makes username immutable once set", async () => {
		const userId = await signUp("imm@kamp.us", "supersecret123", "Imm");

		await setUsername(env, {userId, value: "imm-once"});
		await expectRejectionMessage(setUsername(env, {userId, value: "imm-twice"}), /zaten/);
	});

	it("findUsername returns the row for a set handle", async () => {
		const userId = await signUp("findme@kamp.us", "supersecret123", "FindMe");
		await setUsername(env, {userId, value: "findme"});

		const row = await findUsername(env, "findme");
		expect(row).not.toBeNull();
		expect(row!.userId).toBe(userId);
		expect(row!.username).toBe("findme");
	});

	it("backfills user_profile rows for existing users without usernames", async () => {
		await signUp("withname@kamp.us", "supersecret123", "WithName");
		await signUp("noname@kamp.us", "supersecret123", "NoName");

		const beforeNoName = await countUsersWithoutUsername(env);
		expect(beforeNoName).toBeGreaterThanOrEqual(1);

		const {emitted} = await backfillProfiles(env);
		expect(emitted).toBeGreaterThan(0);

		const total = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as c FROM user_profile",
		).first<{c: number}>();
		expect(total!.c).toBeGreaterThanOrEqual(emitted);
	});
});
