/**
 * Guard (integration, ADR 0082) for `PasaportFromTag`'s inert `RuntimeContext`
 * stub in `features/fate/layers.ts`. `betterAuth.auth` is `Effect<Auth, never,
 * RuntimeContext>`, so `makeFateLayer` discharges that requirement with a hand-built
 * inert stub (empty env, no-op get/set) to keep its `R` exactly
 * `Database | BetterAuth`. That is safe ONLY because phoenix's better-auth fork
 * reads its secret from a binding and never touches `RuntimeContext` during auth
 * resolution.
 *
 * The real deployed worker is precisely this path — `index.ts` builds its isolate runtime
 * through the same `makeFateRuntime(PhoenixFateLive)` → `makeFateLayer` →
 * `PasaportFromTag` with the inert stub — so a black-box session round-trip over the
 * deployed worker exercises the stub against real remote D1: a sign-up cookie that
 * resolves an authenticated `me` proves `validateSession` round-trips through the
 * real `PasaportFromTag` path with only the inert RuntimeContext stub.
 *
 * If the fork (or upstream `@alchemy.run/better-auth`) ever starts reading
 * `RuntimeContext` while resolving `auth` — most likely via a better-auth dep bump —
 * auth resolution fails at deploy/request time and this round-trip goes red. The fix
 * is to widen `makeFateLayer`'s `R` to include `RuntimeContext` (and provide the real
 * one), NOT to delete this test.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();

const NS = nsToken(import.meta.url);

describe("PasaportFromTag — inert RuntimeContext stub guard (real D1)", () => {
	let session: {userId: string; cookie: string};

	beforeAll(async () => {
		session = await h.signUp(`${NS}-guard@example.com`, "hunter2hunter2", "guard");
	});

	it("a session round-trips through PasaportFromTag with only the inert stub", async () => {
		// `me` is the authenticated identity read: it flows through
		// `Pasaport.validateSession`, which the deployed worker resolves via
		// `PasaportFromTag` discharging `betterAuth.auth`'s RuntimeContext requirement
		// with ONLY the inert stub baked into `layers.ts`. A non-null result proves the
		// stub was sufficient to resolve auth end-to-end against real remote D1.
		const me = await h.fate(
			{kind: "query", name: "me", select: ["id", "email"]},
			{cookie: session.cookie},
		);
		expect(me.ok).toBe(true);
		if (!me.ok) return;
		const data = me.data as {id: string; email: string};
		expect(data.id).toBe(session.userId);
		expect(data.email).toBe(`${NS}-guard@example.com`);
	});
});
