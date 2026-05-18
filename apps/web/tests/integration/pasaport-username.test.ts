/**
 * Username bootstrap integration test — D1-direct path via the Pasaport
 * Context.Service (effect-migration task 2).
 *
 * Exercises the resolver-side path end-to-end inside workerd:
 *   1. Apply the D1 schema (including the auth tables in migration 0000).
 *   2. Seed a Pasaport user via better-auth's sign-up handler driven through
 *      `Pasaport.handleAuth(request)`.
 *   3. Call `Pasaport.setUsername({userId, value})` and verify validation,
 *      uniqueness, immutability, and that the `user_profile` row lands in the
 *      same D1 transaction.
 *   4. Verify `PasaportAdmin.backfillProfiles` emits a `user_profile` row for
 *      users without usernames.
 *
 * Layer setup: `PasaportLive + PasaportAdminLive + DrizzleLive` provided with
 * `CloudflareEnv = miniflareEnv`. No mocking; the real D1 binding underneath.
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:workers";
import {Cause, Effect, Exit, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {Pasaport, PasaportLive} from "../../worker/features/pasaport/Pasaport";
import {PasaportAdmin, PasaportAdminLive} from "../../worker/features/pasaport/PasaportAdmin";
import {CloudflareEnv, DrizzleLive} from "../../worker/services";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

const TestLive = Layer.mergeAll(PasaportLive, PasaportAdminLive).pipe(
	Layer.provide(DrizzleLive),
	Layer.provide(Layer.succeed(CloudflareEnv, env)),
);

async function applyViewMigrations() {
	const sources = [baselineMigration];
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
 * `Pasaport.handleAuth` constructs better-auth per-request, the same code path
 * the production worker uses. Returns the new user id.
 */
async function signUp(email: string, password: string, name: string): Promise<string> {
	const req = new Request("https://example.com/api/auth/sign-up/email", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({email, password, name}),
	});
	const response = await Effect.runPromise(
		Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			return yield* pasaport.handleAuth(req);
		}).pipe(Effect.provide(TestLive)),
	);
	if (!response.ok) {
		throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
	}
	const data = (await response.json()) as {user?: {id: string}};
	if (!data.user?.id) throw new Error("sign-up returned no user id");
	return data.user.id;
}

async function runSetUsername(userId: string, value: string) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			return yield* pasaport.setUsername({userId, value});
		}).pipe(Effect.provide(TestLive)),
	);
}

async function expectFailureMessage(
	program: Effect.Effect<unknown, unknown, never>,
	match: RegExp,
): Promise<void> {
	const exit = await Effect.runPromise(Effect.exit(program));
	if (Exit.isSuccess(exit)) throw new Error("expected failure");
	const found = Cause.findError(exit.cause);
	if (found._tag !== "Success") throw new Error("expected typed failure");
	const err = found.success as {message?: string};
	expect(err.message ?? "").toMatch(match);
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("pasaport.setUsername — bootstrap flow + user_profile (D1-direct)", () => {
	it("sets a username and lands a user_profile row with the unique handle", async () => {
		const userId = await signUp("elif@kamp.us", "supersecret123", "Elif Kaya");

		const result = await runSetUsername(userId, "elif");
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

		const program = (value: string) =>
			Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				return yield* pasaport.setUsername({userId, value});
			}).pipe(Effect.provide(TestLive));

		await expectFailureMessage(program("ab"), /en az 3/);
		await expectFailureMessage(program("a".repeat(31)), /en fazla 30/);
		await expectFailureMessage(program("Bad Spaces"), /küçük harf/);
		await expectFailureMessage(program("-leading"), /küçük harf/);
		await expectFailureMessage(program("trailing-"), /küçük harf/);
	});

	it("rejects duplicate usernames", async () => {
		const u1 = await signUp("first@kamp.us", "supersecret123", "First");
		const u2 = await signUp("second@kamp.us", "supersecret123", "Second");

		await runSetUsername(u1, "umut");
		await expectFailureMessage(
			Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				return yield* pasaport.setUsername({userId: u2, value: "umut"});
			}).pipe(Effect.provide(TestLive)),
			/kullanımda/,
		);
	});

	it("makes username immutable once set", async () => {
		const userId = await signUp("imm@kamp.us", "supersecret123", "Imm");

		await runSetUsername(userId, "imm-once");
		await expectFailureMessage(
			Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				return yield* pasaport.setUsername({userId, value: "imm-twice"});
			}).pipe(Effect.provide(TestLive)),
			/zaten/,
		);
	});

	it("findUsername returns the row for a set handle", async () => {
		const userId = await signUp("findme@kamp.us", "supersecret123", "FindMe");
		await runSetUsername(userId, "findme");

		const row = await Effect.runPromise(
			Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				return yield* pasaport.findUsername("findme");
			}).pipe(Effect.provide(TestLive)),
		);
		expect(row).not.toBeNull();
		expect(row!.userId).toBe(userId);
		expect(row!.username).toBe("findme");
	});

	it("backfills user_profile rows for existing users without usernames", async () => {
		await signUp("withname@kamp.us", "supersecret123", "WithName");
		await signUp("noname@kamp.us", "supersecret123", "NoName");

		const beforeNoName = await Effect.runPromise(
			Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				return yield* pasaport.countUsersWithoutUsername;
			}).pipe(Effect.provide(TestLive)),
		);
		expect(beforeNoName).toBeGreaterThanOrEqual(1);

		const {emitted} = await Effect.runPromise(
			Effect.gen(function* () {
				const admin = yield* PasaportAdmin;
				return yield* admin.backfillProfiles;
			}).pipe(Effect.provide(TestLive)),
		);
		expect(emitted).toBeGreaterThan(0);

		const total = await env.PHOENIX_DB.prepare("SELECT COUNT(*) as c FROM user_profile").first<{
			c: number;
		}>();
		expect(total!.c).toBeGreaterThanOrEqual(emitted);
	});
});
