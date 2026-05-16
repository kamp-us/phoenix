/**
 * Username bootstrap + user_profile MV integration test.
 *
 * Exercises T13 end-to-end inside workerd:
 *   1. Apply the Pasaport DO migration (already happens implicitly on the
 *      first DO instantiation), then apply the D1 view migrations.
 *   2. Seed a Pasaport user via Better Auth's signUp so the DO has a real
 *      row to set the username on.
 *   3. Call `Pasaport.setUsername` directly and verify validation, uniqueness,
 *      and immutability.
 *   4. Verify the projection wrote a `user_profile` MV row with the username.
 *   5. Verify backfill emits `UserProfileChanged` for users without usernames.
 */
import {env} from "cloudflare:test";
import {beforeAll, describe, expect, it} from "vitest";
import viewMigration0000 from "../../worker/db/drizzle/migrations/0000_secret_iron_patriot.sql";
import viewMigration0001 from "../../worker/db/drizzle/migrations/0001_free_salo.sql";
import viewMigration0002 from "../../worker/db/drizzle/migrations/0002_wandering_natasha_romanoff.sql";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

async function applyViewMigrations() {
	const sources = [viewMigration0000, viewMigration0001, viewMigration0002];
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
					!msg.includes("no such table")
				) {
					throw err;
				}
			}
		}
	}
}

async function waitForUserProfile(
	username: string,
	attempts = 20,
): Promise<{user_id: string; username: string} | null> {
	for (let i = 0; i < attempts; i++) {
		const row = await env.PHOENIX_DB.prepare(
			"SELECT user_id, username FROM user_profile WHERE username = ?",
		)
			.bind(username)
			.first<{user_id: string; username: string}>();
		if (row) return row;
		await new Promise((r) => setTimeout(r, 100));
	}
	return null;
}

/**
 * Drive Better Auth via the Pasaport DO `fetch` interface so the row lands
 * through the canonical sign-up path (no admin write). Returns the new user id.
 */
async function signUp(email: string, password: string, name: string): Promise<string> {
	const stub = env.PASAPORT.get(env.PASAPORT.idFromName("kampus"));
	const req = new Request("https://example.com/api/auth/sign-up/email", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({email, password, name}),
	});
	const response = await stub.fetch(req);
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

/**
 * Helper around expected RPC rejections. Workerd's RPC layer wraps thrown
 * errors and vitest's `rejects.toThrow` lets the underlying rejection surface
 * as an unhandled error in the test report (even though the test passes).
 * Catch + assert the message string instead so the run is clean.
 */
async function expectRejectionMessage(promise: Promise<unknown>, match: RegExp): Promise<void> {
	try {
		await promise;
		throw new Error("expected rejection");
	} catch (err) {
		expect((err as Error).message).toMatch(match);
	}
}

describe("Pasaport.setUsername — bootstrap flow + user_profile MV", () => {
	it("sets a username and projects a user_profile row with the unique handle", async () => {
		const userId = await signUp("elif@kamp.us", "supersecret123", "Elif Kaya");
		const stub = env.PASAPORT.get(env.PASAPORT.idFromName("kampus"));

		const result = await stub.setUsername({userId, value: "elif"});
		expect(result.username).toBe("elif");
		expect(result.userId).toBe(userId);

		// Convergence: the projection wrote the MV row.
		const row = await waitForUserProfile("elif");
		expect(row).not.toBeNull();
		expect(row!.user_id).toBe(userId);
		expect(row!.username).toBe("elif");
	});

	it("rejects invalid usernames", async () => {
		const userId = await signUp("a@kamp.us", "supersecret123", "A");
		const stub = env.PASAPORT.get(env.PASAPORT.idFromName("kampus"));

		await expectRejectionMessage(stub.setUsername({userId, value: "ab"}), /en az 3/);
		await expectRejectionMessage(stub.setUsername({userId, value: "a".repeat(31)}), /en fazla 30/);
		await expectRejectionMessage(stub.setUsername({userId, value: "Bad Spaces"}), /küçük harf/);
		await expectRejectionMessage(stub.setUsername({userId, value: "-leading"}), /küçük harf/);
		await expectRejectionMessage(stub.setUsername({userId, value: "trailing-"}), /küçük harf/);
	});

	it("rejects duplicate usernames", async () => {
		const u1 = await signUp("first@kamp.us", "supersecret123", "First");
		const u2 = await signUp("second@kamp.us", "supersecret123", "Second");
		const stub = env.PASAPORT.get(env.PASAPORT.idFromName("kampus"));

		await stub.setUsername({userId: u1, value: "umut"});
		await expectRejectionMessage(stub.setUsername({userId: u2, value: "umut"}), /kullanımda/);
	});

	it("makes username immutable once set", async () => {
		const userId = await signUp("imm@kamp.us", "supersecret123", "Imm");
		const stub = env.PASAPORT.get(env.PASAPORT.idFromName("kampus"));

		await stub.setUsername({userId, value: "imm-once"});
		await expectRejectionMessage(stub.setUsername({userId, value: "imm-twice"}), /zaten/);
	});

	it("backfills user_profile rows for existing users without usernames", async () => {
		// Sign up two users, set username on one, leave the other empty.
		await signUp("withname@kamp.us", "supersecret123", "WithName");
		await signUp("noname@kamp.us", "supersecret123", "NoName");

		const stub = env.PASAPORT.get(env.PASAPORT.idFromName("kampus"));
		const beforeNoName = await stub.countUsersWithoutUsername();
		expect(beforeNoName).toBeGreaterThanOrEqual(1);

		const {emitted} = await stub.backfillProfiles();
		expect(emitted).toBeGreaterThan(0);

		// Wait for projection. We can't query by username (NULL) so check by
		// total row count climbing past initial backfill.
		await new Promise((r) => setTimeout(r, 500));
		const total = await env.PHOENIX_DB.prepare("SELECT COUNT(*) as c FROM user_profile").first<{
			c: number;
		}>();
		expect(total!.c).toBeGreaterThanOrEqual(emitted);
	});
});
