/**
 * Unit coverage for the pasaport `me` resolver's auth gate — the anonymous → `UNAUTHORIZED`
 * boundary, proven with NO database (ADR 0082).
 *
 * `me` runs through `resolveWire` (decode + the `encodeWireError` class→wire-code seam), so the
 * assertion is on the WIRE `code`, not the typed `Unauthorized` instance one layer in — that is
 * what makes a mis-annotated `[FateWireCode]` a unit failure.
 */

import {it} from "@effect/vitest";
import {RelationStore} from "@kampus/authz";
import {CurrentUser, type CurrentUserInfo} from "@kampus/fate-effect";
import {Cause, Effect, Exit} from "effect";
import {assert} from "vitest";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {Kunye, KunyeLive} from "../kunye/Kunye.ts";
import type {StoredTier} from "../kunye/standing.ts";
import {DELIVERABLE} from "./email-delivery.ts";
import {UserNotFound} from "./errors.ts";
import type {UserRow} from "./Pasaport.ts";
import {Pasaport} from "./Pasaport.ts";
import {queries} from "./queries.ts";

// Fail-on-contact: any method call dies, so a passing test proves the gate never reached the DB.
// `as never` widens the partial stub — the anon path touches none of these methods.
const failOnContactPasaport = {
	getUserById: () => Effect.die("Pasaport.getUserById must not be reached on the anon gate"),
} as never;

const failOnContactKunye = {
	tierOf: () => Effect.die("Kunye.tierOf must not be reached on the anon gate"),
} as never;

const failOnContactRelationStore = {
	has: () => Effect.die("RelationStore.has must not be reached on the anon gate"),
} as never;

// A fixed verdict for the `(subject, "moderates", platform)` membership `me` reads (#1320).
const relationStoreReturning = (isMod: boolean) => ({has: () => Effect.succeed(isMod)}) as never;

// The `me` resolver reads `getUserById` twice — canonical row, then inside `Kunye.tierOf` — so
// this single stub backs both reads.
const storedUser = (tier: StoredTier): UserRow => ({
	id: "u1",
	email: "u1@kamp.us",
	name: "U One",
	image: null,
	username: "u-one",
	tier,
});

// Deliverable by default so the tier/isModerator paths run unaffected (#2693).
const pasaportWithStoredTier = (
	tier: StoredTier,
	deliveryState: {failing: boolean; reason: string | null} = DELIVERABLE,
) =>
	({
		getUserById: () => Effect.succeed(storedUser(tier)),
		getEmailDeliveryState: () => Effect.succeed({address: "u1@kamp.us", state: deliveryState}),
	}) as never;

// Drives `me` over the REAL `Kunye` on a stored-tier Pasaport stub — the trusted
// `getUserById → Kunye.tierOf → view` path end to end.
const resolveMeTier = (user: CurrentUserInfo, pasaport: never) =>
	resolveWire(queries.me, {args: undefined, select: ["id", "tier"]}).pipe(
		Effect.provideService(CurrentUser, {user}),
		Effect.provide(KunyeLive),
		Effect.provideService(Pasaport, pasaport),
		Effect.provideService(RelationStore, relationStoreReturning(false)),
		Effect.map((me) => (me as {tier: string}).tier),
	);

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
		// No stored row → visitor, the read-time rank the column can never store. `getEmailDeliveryState`
		// fails `UserNotFound` here, which the resolver catches to a deliverable signal.
		const noRowPasaport = {
			getUserById: () => Effect.succeed(null),
			getEmailDeliveryState: () => new UserNotFound({message: "kullanıcı bulunamadı"}),
		} as never;
		const tier = yield* resolveMeTier(user, noRowPasaport);
		assert.strictEqual(tier, "visitor");
	}),
);

// #1320 — the SELF moderator signal, read off the `moderates` tuple, never inferred from `tier`:
// the founding author-mod (#1207) is `tier: "yazar"` AND `isModerator: true`.
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

// #2693 — the SELF failing-delivery signal, self-scoped so it can only describe the reader.
const resolveMeEmailFailing = (pasaport: never) =>
	resolveWire(queries.me, {args: undefined, select: ["id", "emailFailing"]}).pipe(
		Effect.provideService(CurrentUser, {user: u1}),
		Effect.provide(KunyeLive),
		Effect.provideService(Pasaport, pasaport),
		Effect.provideService(RelationStore, relationStoreReturning(false)),
		Effect.map((me) => (me as {emailFailing?: boolean}).emailFailing),
	);

it.effect("me stamps emailFailing true when the reader's own address is failing", () =>
	Effect.gen(function* () {
		const failing = yield* resolveMeEmailFailing(
			pasaportWithStoredTier("yazar", {failing: true, reason: "hard-bounce"}),
		);
		assert.strictEqual(failing, true);
	}),
);

it.effect("me stamps emailFailing false when the reader's own address is deliverable", () =>
	Effect.gen(function* () {
		const failing = yield* resolveMeEmailFailing(pasaportWithStoredTier("yazar"));
		assert.strictEqual(failing, false);
	}),
);
