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
import {RelationStore} from "@kampus/authz";
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

// Same intent for `RelationStore`: the anon gate short-circuits before the
// `isModerator` read (#1320), so a reached `has` would `die` (not `Unauthorized`).
const failOnContactRelationStore = {
	has: () => Effect.die("RelationStore.has must not be reached on the anon gate"),
} as never;

// A `RelationStore` answering a fixed moderator verdict for any tuple — the
// `(subject, "moderates", platform)` membership the `me` resolver reads `isModerator`
// off (#1320). `true` ⇒ the subject is a platform moderator, `false` ⇒ not.
const relationStoreReturning = (isMod: boolean) => ({has: () => Effect.succeed(isMod)}) as never;

// A stored account row carrying a given authorship tier. The `me` resolver reads
// `getUserById` twice — once for the canonical row, once inside `Kunye.tierOf` —
// so this single stub backs both reads.
const storedUser = (tier: StoredTier): UserRow => ({
	id: "u1",
	email: "u1@kamp.us",
	name: "U One",
	image: null,
	username: "u-one",
	tier,
});

const pasaportWithStoredTier = (tier: StoredTier) =>
	({getUserById: () => Effect.succeed(storedUser(tier))}) as never;

// Drive `me` to the resolved wire object's `tier` scalar over the REAL `Kunye`
// (KunyeLive) layered on a stored-tier Pasaport stub — exercising the trusted
// `getUserById → Kunye.tierOf → view` read path end to end. A non-moderator
// `RelationStore` backs the orthogonal `isModerator` read so the `tier` path runs.
const resolveMeTier = (user: CurrentUserInfo, pasaport: never) =>
	resolveWire(queries.me, {args: undefined, select: ["id", "tier"]}).pipe(
		Effect.provideService(CurrentUser, {user}),
		Effect.provide(KunyeLive),
		Effect.provideService(Pasaport, pasaport),
		Effect.provideService(RelationStore, relationStoreReturning(false)),
		Effect.map((me) => (me as {tier: string}).tier),
	);

// Drive `me` to the resolved wire object's `isModerator` scalar (#1320) — the SELF
// moderator signal read off the `moderates` relation tuple via `RelationStore`,
// keyed on the current user. The `relationStore` stub fixes the membership verdict;
// `tier` rides the same stored-tier Pasaport stub so a dual-role case is expressible.
const resolveMeIsModerator = (user: CurrentUserInfo, pasaport: never, relationStore: never) =>
	resolveWire(queries.me, {args: undefined, select: ["id", "isModerator"]}).pipe(
		Effect.provideService(CurrentUser, {user}),
		Effect.provide(KunyeLive),
		Effect.provideService(Pasaport, pasaport),
		Effect.provideService(RelationStore, relationStore),
		Effect.map((me) => (me as {isModerator: boolean}).isModerator),
	);

it.effect(
	"me on an anonymous request fails with the wire UNAUTHORIZED before any Pasaport read",
	() =>
		Effect.gen(function* () {
			const exit = yield* resolveWire(queries.me, {args: undefined, select: ["id"]}).pipe(
				Effect.provideService(CurrentUser, {user: undefined}),
				Effect.provideService(Pasaport, failOnContactPasaport),
				Effect.provideService(Kunye, failOnContactKunye),
				Effect.provideService(RelationStore, failOnContactRelationStore),
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

// #1320 — the SELF moderator signal, read off the `moderates` relation tuple (the
// trusted source `Moderate.over(platform)` checks), self-only, never inferred from
// `tier`. The dual-role case is the founding author-mod (#1207): `tier: "yazar"` AND
// `isModerator: true` — exactly what `tier` alone cannot express.
const u1: CurrentUserInfo = {id: "u1", email: "u1@kamp.us", name: "U One", image: null};

it.effect("me carries isModerator true for a dual-role yazar+moderator (the #1207 cohort)", () =>
	Effect.gen(function* () {
		const isMod = yield* resolveMeIsModerator(
			u1,
			pasaportWithStoredTier("yazar"),
			relationStoreReturning(true),
		);
		assert.strictEqual(isMod, true);
	}),
);

it.effect("me carries isModerator true for a moderator who is not yet yazar", () =>
	Effect.gen(function* () {
		const isMod = yield* resolveMeIsModerator(
			u1,
			pasaportWithStoredTier("çaylak"),
			relationStoreReturning(true),
		);
		assert.strictEqual(isMod, true);
	}),
);

it.effect("me carries isModerator false for a yazar who holds no moderates tuple", () =>
	Effect.gen(function* () {
		const isMod = yield* resolveMeIsModerator(
			u1,
			pasaportWithStoredTier("yazar"),
			relationStoreReturning(false),
		);
		assert.strictEqual(isMod, false);
	}),
);
