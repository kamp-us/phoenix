/**
 * Guard test (T2) for `PasaportFromTag`'s inert `RuntimeContext` stub in
 * `features/fate/layers.ts`. `betterAuth.auth` is `Effect<Auth, never,
 * RuntimeContext>`, so `makeFateLayer` discharges that requirement with a
 * hand-built inert stub (empty env, no-op get/set) to keep its `R` exactly
 * `Database | BetterAuth`. That is safe ONLY because phoenix's better-auth fork
 * reads its secret from a binding and never touches `RuntimeContext` during auth
 * resolution.
 *
 * Pins the invariant that auth resolution succeeds with ONLY the inert stub:
 * resolves `Pasaport` through the REAL `PasaportFromTag` path (a real
 * `makeRealAuthForTest` instance over `node:sqlite` via `layerTest`, NOT the
 * `layerStub` bypass) and proves `validateSession` round-trips a real session.
 *
 * When the fork (or upstream `@alchemy.run/better-auth`) starts reading
 * `RuntimeContext` while resolving `auth` — most likely via a better-auth dep
 * bump — this dies in-process pointing at `PasaportFromTag`, where `app.test.ts`
 * would fail with a confusing distant error. The fix is to widen
 * `makeFateLayer`'s `R` to include `RuntimeContext` (and provide the real one),
 * NOT to delete this test.
 */
import {Effect, Layer} from "effect";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {Database} from "../../db/Database";
import {makeSqliteTestDb, type SqliteD1} from "../../db/sqlite-d1.testing";
import {layerTest, makeRealAuthForTest} from "../pasaport/better-auth.testing";
import {Pasaport} from "../pasaport/Pasaport";
import {makeFateLayer} from "./layers";

let sqlite: SqliteD1;

beforeEach(() => {
	sqlite = makeSqliteTestDb();
});

afterEach(() => {
	sqlite?.close();
});

describe("PasaportFromTag — inert RuntimeContext stub guard", () => {
	it("resolves Pasaport through the real auth path and validateSession works", async () => {
		const auth = makeRealAuthForTest(sqlite.d1);

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

		// `makeFateLayer` discharges `betterAuth.auth`'s `RuntimeContext`
		// requirement with ONLY the inert stub baked into `layers.ts`; a real (not
		// stubbed) better-auth fake over the `BetterAuth` tag keeps auth resolution
		// genuine.
		const WorkerLive = makeFateLayer.pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(Database)(sqlite.d1),
					// biome-ignore lint/plugin: concrete `Auth<…>` vs the generic `Auth` don't overlap (TS2345), so this widen needs the hop.
					layerTest(auth as unknown as Parameters<typeof layerTest>[0]),
				),
			),
		);

		const session = await Effect.runPromise(
			Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				return yield* pasaport.validateSession(new Headers({cookie}));
			}).pipe(Effect.provide(WorkerLive)),
		);

		// The inert RuntimeContext stub was sufficient to resolve auth end-to-end.
		expect(session).not.toBeNull();
		expect(session!.user.email).toBe("guard@example.com");
	});
});
