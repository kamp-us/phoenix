/**
 * Guard test for `PasaportFromTag`'s inert `RuntimeContext` stub
 * (`features/fate/layers.ts`, the `inertRuntimeContext` + `PasaportFromTag` block).
 *
 * **The stub.** `betterAuth.auth`'s value type is `Effect<Auth, never, RuntimeContext>`, so
 * resolving the instance type-requires alchemy's `RuntimeContext`. `makeFateLayer` discharges
 * that requirement with a hand-built **inert** stub (empty env, no-op get/set) so its `R` stays
 * exactly `Database | BetterAuth`. That is runtime-safe **only** because phoenix's better-auth
 * fork reads its secret from a binding and never touches `RuntimeContext` during auth
 * resolution.
 *
 * **The invariant pinned.** Auth resolution succeeds with ONLY the inert stub — i.e. nothing
 * reads `RuntimeContext` during session validation. The test resolves `Pasaport` through the
 * REAL `PasaportFromTag` path — a real better-auth instance (`makeRealAuthForTest`) over
 * `node:sqlite` wrapped by `layerTest`, NOT the `layerStub` bypass — with only the inert
 * `RuntimeContext` discharging the requirement, then proves `Pasaport.validateSession`
 * resolves a real session end-to-end.
 *
 * **When it fails.** The fork (or upstream `@alchemy.run/better-auth`) has started reading
 * `RuntimeContext` while resolving `auth` — most likely arriving via a better-auth dep bump.
 * This test dies in-process pointing straight at `PasaportFromTag`, where `app.test.ts` would
 * fail with a confusing distant error. The fix then is to widen `makeFateLayer`'s `R` to
 * include `RuntimeContext` (and provide the real one), NOT to delete this test.
 *
 * Keep decision: 2026-06-12 architecture audit — the watched fragility is fork-drift, which is
 * a live channel in this project.
 *
 * (T2 — `app.test.ts` exercises this path implicitly through the whole router;
 * this is the focused, self-diagnosing version.)
 */
import {Effect, Layer} from "effect";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {Database} from "../../db/Database";
import {makeSqliteTestDb, type SqliteD1} from "../../db/sqlite-d1.testing";
import {layerTest, makeRealAuthForTest} from "../pasaport/better-auth.testing";
import {Pasaport} from "../pasaport/Pasaport";
import {makeFateLayer} from "./layers";

/** The per-test in-memory D1; created in `beforeEach`, closed in `afterEach`. */
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

		// A working session: the inert RuntimeContext stub was sufficient to resolve
		// auth, and `getSession` round-trips through it to the signed-up user.
		expect(session).not.toBeNull();
		expect(session!.user.email).toBe("guard@example.com");
	});
});
