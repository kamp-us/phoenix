/**
 * Guard test for `PasaportFromTag`'s inert `RuntimeContext` stub (`layers.ts`).
 *
 * `makeFateLayer`'s `PasaportFromTag` resolves the better-auth instance from the
 * `BetterAuth` Context tag while satisfying the *type-level* `RuntimeContext`
 * requirement on `betterAuth.auth` with a hand-built **inert** stub (`layers.ts`
 * ~lines 78-94). That is runtime-safe **only** because phoenix's better-auth
 * fork reads its secret from a binding and never touches `RuntimeContext` during
 * auth resolution. The day the fork (or upstream `@alchemy.run/better-auth`)
 * starts reading `RuntimeContext` while resolving `auth`, a deployed session
 * would silently mis-resolve.
 *
 * This test pins the contract so that regression fails **in-process** instead of
 * in prod: it resolves `Pasaport` through the REAL `PasaportFromTag` path — a
 * real better-auth fake over `node:sqlite`, NOT the `makeStubBetterAuthLayer`
 * bypass — with only the inert `RuntimeContext` discharging the requirement, then
 * proves `Pasaport.validateSession` resolves a real session end-to-end. If the
 * inert stub ever stops being sufficient, the auth resolution inside `makeFateLayer`
 * dies and this named test points straight at `PasaportFromTag`.
 *
 * (T2 — `app.test.ts` exercises this path implicitly through the whole router;
 * this is the focused, self-diagnosing version.)
 */
import {type BetterAuthOptions, betterAuth as makeBetterAuth} from "better-auth";
import {drizzleAdapter} from "better-auth/adapters/drizzle";
import {bearer} from "better-auth/plugins";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {Database} from "../../db/Database";
import * as schema from "../../db/drizzle/schema";
import {makeSqliteTestDb, type SqliteD1} from "../../db/sqlite-d1.fake";
import {makeBetterAuthTestLayer} from "../pasaport/better-auth.fake";
import {Pasaport} from "../pasaport/Pasaport";
import {makeFateLayer} from "./layers";

const ENV = {
	BETTER_AUTH_URL: "http://localhost:3000",
	BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3000",
	BETTER_AUTH_SECRET: "phoenix-guard-secret",
} as const;

/** The per-test in-memory D1; created in `beforeEach`, closed in `afterEach`. */
let sqlite: SqliteD1;

beforeEach(() => {
	sqlite = makeSqliteTestDb();
});

afterEach(() => {
	sqlite?.close();
});

/**
 * Build a real better-auth instance over the per-test `node:sqlite` D1 — the
 * same construction `app.test.ts` uses, mirroring the deployed `BetterAuthLive`
 * but constructed directly because that Layer needs the alchemy provider stack
 * the node pool lacks.
 */
function makeRealAuth() {
	const betterAuthDrizzle = drizzle(sqlite.d1, {schema});
	const instance = makeBetterAuth({
		emailAndPassword: {enabled: true},
		database: drizzleAdapter(betterAuthDrizzle, {provider: "sqlite", schema}),
		secret: ENV.BETTER_AUTH_SECRET,
		baseURL: ENV.BETTER_AUTH_URL,
		trustedOrigins: [ENV.BETTER_AUTH_TRUSTED_ORIGINS],
		user: {
			additionalFields: {
				username: {type: "string", required: false, input: false},
			},
		},
		plugins: [bearer()],
	} satisfies BetterAuthOptions);
	return instance;
}

describe("PasaportFromTag — inert RuntimeContext stub guard", () => {
	it("resolves Pasaport through the real auth path and validateSession works", async () => {
		const auth = makeRealAuth();

		// Sign a user up directly against the same auth instance to mint a real
		// session, then capture the session cookie it sets.
		const signUp = await auth.handler(
			new Request("http://localhost:3000/api/auth/sign-up/email", {
				method: "POST",
				headers: {"content-type": "application/json"},
				body: JSON.stringify({
					email: "guard@example.com",
					password: "hunter2hunter2",
					name: "guard",
				}),
			}),
		);
		expect([200, 201]).toContain(signUp.status);
		const setCookie = signUp.headers.get("set-cookie");
		expect(setCookie).toBeTruthy();
		const cookie = setCookie!.split(";")[0]!;

		// The REAL `PasaportFromTag` path: `makeFateLayer` resolves `Pasaport`'s
		// auth from the `BetterAuth` tag, discharging `betterAuth.auth`'s
		// `RuntimeContext` requirement with ONLY the inert stub baked into
		// `layers.ts`. A real (not stubbed) better-auth fake is provided over the
		// `BetterAuth` tag so the auth resolution is the genuine one.
		const WorkerLive = makeFateLayer.pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(Database)(sqlite.d1),
					// biome-ignore lint/plugin: concrete `Auth<…>` vs the generic `Auth` don't overlap (TS2345), so this widen needs the hop.
					makeBetterAuthTestLayer(auth as unknown as Parameters<typeof makeBetterAuthTestLayer>[0]),
				),
			),
		);

		const session = await Effect.runPromise(
			Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				return yield* pasaport.validateSession(new Headers({cookie}));
			}).pipe(Effect.provide(WorkerLive)),
		);

		// A working session: the inert RuntimeContext stub was sufficient to resolve
		// auth, and `getSession` round-trips through it to the signed-up user.
		expect(session).not.toBeNull();
		expect(session!.user.email).toBe("guard@example.com");
	});
});
