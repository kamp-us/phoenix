/**
 * Unit coverage for the pasaport `me` resolver's auth gate — the anonymous →
 * `UNAUTHORIZED` boundary, proven with NO database (ADR 0082). The litmus: the
 * gate is wrong-or-right independent of the DB — `CurrentUser.required` fails
 * before any `Pasaport` read — so it belongs at `unit`, not on a database.
 *
 * The `me` op runs through `resolveWire` — its real external interface (`resolve`
 * decode + the `encodeWireError` class→wire-code seam) — over an anonymous
 * `CurrentUser` and a fail-on-contact `Pasaport` sentinel: the sentinel proves the
 * gate short-circuits the DB read (a reached read would `die` → `INTERNAL_SERVER_ERROR`,
 * not `UNAUTHORIZED`). Asserting the WIRE `code` (not the typed `Unauthorized`
 * instance one layer in) is what makes a mis-annotated `[FateWireCode]` a unit failure.
 */

import {it} from "@effect/vitest";
import {CurrentUser, type CurrentUserInfo} from "@kampus/fate-effect";
import {Cause, Effect, Exit} from "effect";
import {assert} from "vitest";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {Kunye, KunyeLive} from "../kunye/Kunye.ts";
import type {StoredTier} from "../kunye/standing.ts";
import type {UserRow} from "./Pasaport.ts";
import {Pasaport} from "./Pasaport.ts";
import {queries} from "./queries.ts";

// Fail-on-contact `Pasaport`: any method call dies, so a passing test proves the
// gate never reached the DB (a reached read would `die`, not `Unauthorized`).
// `as never` widens the partial stub to the full service shape — the anon path
// touches none of these methods.
const failOnContactPasaport = {
	getUserById: () => Effect.die("Pasaport.getUserById must not be reached on the anon gate"),
} as never;

// Same intent for `Kunye`: the anon gate fails at `CurrentUser.required` before
// any tier read, so a reached `tierOf` would `die` (not `Unauthorized`).
const failOnContactKunye = {
	tierOf: () => Effect.die("Kunye.tierOf must not be reached on the anon gate"),
} as never;

// A stored account row carrying a given authorship tier. The `me` resolver reads
// `getUserById` twice — once for the canonical row, once inside `Kunye.tierOf` —
// so this single stub backs both reads.
const storedUser = (tier: StoredTier): UserRow => ({
	id: "u1",
	email: "u1@kamp.us",
	name: "U One",
	image: null,
	username: "u-one",
	role: "member",
	tier,
});

const pasaportWithStoredTier = (tier: StoredTier) =>
	({getUserById: () => Effect.succeed(storedUser(tier))}) as never;

// Drive `me` to the resolved wire object's `tier` scalar over the REAL `Kunye`
// (KunyeLive) layered on a stored-tier Pasaport stub — exercising the trusted
// `getUserById → Kunye.tierOf → view` read path end to end.
const resolveMeTier = (user: CurrentUserInfo, pasaport: never) =>
	resolveWire(queries.me, {args: undefined, select: ["id", "tier"]}).pipe(
		Effect.provideService(CurrentUser, {user}),
		Effect.provide(KunyeLive),
		Effect.provideService(Pasaport, pasaport),
		Effect.map((me) => (me as {tier: string}).tier),
	);

it.effect(
	"me on an anonymous request fails with the wire UNAUTHORIZED before any Pasaport read",
	() =>
		Effect.gen(function* () {
			const exit = yield* resolveWire(queries.me, {args: undefined, select: ["id"]}).pipe(
				Effect.provideService(CurrentUser, {user: undefined}),
				Effect.provideService(Pasaport, failOnContactPasaport),
				Effect.provideService(Kunye, failOnContactKunye),
				Effect.exit,
			);
			// The wire `UNAUTHORIZED` a client sees — derived by `encodeWireError` from the
			// `Unauthorized` class's `[FateWireCode]` annotation, not the typed instance one
			// layer in. A defect from a reached DB read would be `INTERNAL_SERVER_ERROR`.
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) {
				const error = Cause.findErrorOption(exit.cause);
				assert.isTrue(error._tag === "Some");
				if (error._tag === "Some") {
					assert.strictEqual(error.value.code, "UNAUTHORIZED");
				}
			}
		}),
);

it.effect("me carries tier from the stored column via Kunye.tierOf, NOT the session field", () =>
	Effect.gen(function* () {
		// Session claims `yazar`; the stored column says `çaylak`. The trusted read
		// must win — proving the resolver ignores the `input:false` session tier (#1297).
		const sessionUserClaimingYazar = {
			id: "u1",
			email: "u1@kamp.us",
			name: "U One",
			image: null,
			tier: "yazar",
		} satisfies CurrentUserInfo & {tier: string};
		const tier = yield* resolveMeTier(sessionUserClaimingYazar, pasaportWithStoredTier("çaylak"));
		assert.strictEqual(tier, "çaylak");
	}),
);

it.effect("me reflects a stored yazar account on the trusted path", () =>
	Effect.gen(function* () {
		const user = {
			id: "u1",
			email: "u1@kamp.us",
			name: "U One",
			image: null,
		} satisfies CurrentUserInfo;
		const tier = yield* resolveMeTier(user, pasaportWithStoredTier("yazar"));
		assert.strictEqual(tier, "yazar");
	}),
);

it.effect("me ranks a row-missing principal as visitor (Kunye.tierOf fallback)", () =>
	Effect.gen(function* () {
		const user = {
			id: "u1",
			email: "u1@kamp.us",
			name: "U One",
			image: null,
		} satisfies CurrentUserInfo;
		// No stored row → both the canonical read and Kunye.tierOf see null → visitor,
		// the read-time rank the column can never store.
		const noRowPasaport = {getUserById: () => Effect.succeed(null)} as never;
		const tier = yield* resolveMeTier(user, noRowPasaport);
		assert.strictEqual(tier, "visitor");
	}),
);
