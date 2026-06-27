/**
 * The çaylak-SELF authorship-standing read (`myAuthorshipStanding`, #1316, epic
 * #1202) — the aggregate the #1291 status block consumes about ITSELF.
 *
 * What this proves (ADR 0082 unit tier — no DB; the trusted-source composition and
 * the gates are wrong-or-right independent of D1):
 *   - the read returns the reader's own `{karma, bar, vouchExists, inReviewCount}`
 *     from the trusted sources (`Kunye.karmaOf` / `VouchLedger.hasActiveFor` /
 *     `Pasaport.countInReview`), keyed on `CurrentUser` — never an input arg, so a
 *     çaylak cannot read another user's self-status;
 *   - `bar` is the vouch-aware promotion bar (reduced when vouched, full otherwise),
 *     so the frontend never hardcodes it;
 *   - dark-ship: flag OFF ⇒ `null`, and NO trusted source is touched (the
 *     fail-on-contact stubs would `die` if reached);
 *   - anonymous ⇒ the wire `UNAUTHORIZED` before any read;
 *   - ONE-WAY-GLASS, structural: the payload TYPE carries ONLY aggregate scalars —
 *     no reviewer/voter/voucher identity field exists to fill (a compile-time guard,
 *     plus a runtime key assertion on the resolved payload).
 */

import {assert, describe, it} from "@effect/vitest";
import {CurrentUser, type CurrentUserInfo} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Cause, Effect, Exit, Layer} from "effect";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {Flags} from "../flagship/Flags.ts";
import {Kunye} from "../kunye/Kunye.ts";
import {KARMA_THRESHOLDS, VOUCH_PROMOTION_KARMA_BAR} from "../kunye/standing.ts";
import {makeVouchLedgerStub} from "../kunye/VouchLedger.testing.ts";
import type {VouchLedger} from "../kunye/VouchLedger.ts";
import {makePasaportStub} from "./Pasaport.testing.ts";
import {queries} from "./queries.ts";
import type {AuthorshipStanding} from "./views.ts";

// ── ONE-WAY-GLASS, enforced in the TYPE (the #1316 hard AC) ──────────────────
// The standing payload's keys are EXACTLY the aggregate set. Adding ANY
// reviewer/voter/voucher identity field to `AuthorshipStanding` (a `voucherId`,
// `reviewers`, a per-person count, …) breaks this `extends` both ways and is a
// COMPILE error here — the leak is unrepresentable, not merely unsent.
type StandingKeys = keyof Omit<AuthorshipStanding, "__typename">;
type ExpectedKeys = "id" | "karma" | "bar" | "vouchExists" | "inReviewCount";
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _oneWayGlassByType: Exact<StandingKeys, ExpectedKeys> = true;
void _oneWayGlassByType;

const runtimeContextStub: BaseRuntimeContext = {
	Type: "authorship-standing-test",
	id: "authorship-standing-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

const flagsStub = (on: boolean): Layer.Layer<Flags> =>
	Layer.succeed(
		Flags,
		// biome-ignore lint/plugin: a Flags test double — only getBoolean is exercised on this gate; the typed variations add nothing.
		{
			getBoolean: () => Effect.succeed(on),
			getString: () => Effect.die(new Error("unused")),
			getNumber: () => Effect.die(new Error("unused")),
			getObject: () => Effect.die(new Error("unused")),
		} as unknown as typeof Flags.Service,
	);

// A `Kunye` answering karma by id; `tierOf`/`rootOf` die — the standing read never
// reads them (it reads only `karmaOf`), so a reached call fails the test.
const kunyeWithKarma = (karmaById: Record<string, number>): Layer.Layer<Kunye> =>
	Layer.succeed(Kunye, {
		karmaOf: (id: string) => Effect.succeed(karmaById[id] ?? 0),
		tierOf: () => Effect.die(new Error("Kunye.tierOf must not be reached")),
		rootOf: (id: string) => Effect.succeed(id),
	});

const SELF: CurrentUserInfo = {id: "u-self", email: "self@kamp.us", name: "Self", image: null};

// Drive `myAuthorshipStanding` over the flag + the trusted-source stubs, as `SELF`.
const standingOf = (input: {
	on: boolean;
	user?: CurrentUserInfo | undefined;
	karma?: number;
	vouchExists?: boolean;
	inReviewCount?: number;
	kunye?: Layer.Layer<Kunye>;
	ledger?: Layer.Layer<VouchLedger>;
}) =>
	resolveWire(queries.myAuthorshipStanding, {
		args: undefined,
		select: ["id", "karma", "bar", "vouchExists", "inReviewCount"],
	}).pipe(
		Effect.provide(
			Layer.mergeAll(
				flagsStub(input.on),
				input.kunye ?? kunyeWithKarma({[SELF.id]: input.karma ?? 0}),
				input.ledger ??
					makeVouchLedgerStub({hasActiveFor: () => Effect.succeed(input.vouchExists ?? false)}),
				makePasaportStub({countInReview: () => Effect.succeed(input.inReviewCount ?? 0)}),
			).pipe(
				Layer.provideMerge(Layer.succeed(CurrentUser, {user: "user" in input ? input.user : SELF})),
				Layer.provideMerge(Layer.succeed(RuntimeContext, runtimeContextStub)),
			),
		),
	);

describe("myAuthorshipStanding — the çaylak-self aggregate (#1316)", () => {
	it.effect("returns the reader's own {karma, bar, vouchExists, inReviewCount}", () =>
		Effect.gen(function* () {
			const standing = (yield* standingOf({
				on: true,
				karma: 12,
				vouchExists: true,
				inReviewCount: 3,
			})) as AuthorshipStanding;
			assert.strictEqual(standing.id, SELF.id, "subject is the authenticated reader");
			assert.strictEqual(standing.karma, 12);
			assert.strictEqual(standing.vouchExists, true);
			assert.strictEqual(standing.inReviewCount, 3);
			// vouched ⇒ the reduced tandem bar
			assert.strictEqual(standing.bar, VOUCH_PROMOTION_KARMA_BAR);
		}),
	);

	it.effect("vouchExists=true ⇒ bar is the reduced tandem bar", () =>
		Effect.gen(function* () {
			const standing = (yield* standingOf({on: true, vouchExists: true})) as AuthorshipStanding;
			assert.strictEqual(standing.vouchExists, true);
			assert.strictEqual(standing.bar, VOUCH_PROMOTION_KARMA_BAR);
		}),
	);

	it.effect("vouchExists=false ⇒ bar is the full unassisted yazar threshold", () =>
		Effect.gen(function* () {
			const standing = (yield* standingOf({on: true, vouchExists: false})) as AuthorshipStanding;
			assert.strictEqual(standing.vouchExists, false);
			assert.strictEqual(standing.bar, KARMA_THRESHOLDS.yazar);
		}),
	);

	it.effect("inReviewCount reflects the reader's own sandboxed-not-removed count", () =>
		Effect.gen(function* () {
			const standing = (yield* standingOf({
				on: true,
				vouchExists: false,
				inReviewCount: 7,
			})) as AuthorshipStanding;
			assert.strictEqual(standing.inReviewCount, 7);
		}),
	);

	it.effect("ONE-WAY-GLASS: the resolved payload carries ONLY aggregate keys", () =>
		Effect.gen(function* () {
			const standing = (yield* standingOf({
				on: true,
				karma: 5,
				vouchExists: true,
				inReviewCount: 1,
			})) as AuthorshipStanding;
			// No reviewer/voter/voucher identity field is present at runtime either —
			// the key set is exactly the aggregate scalars (+ the fate `__typename`).
			assert.deepStrictEqual(Object.keys(standing).sort(), [
				"__typename",
				"bar",
				"id",
				"inReviewCount",
				"karma",
				"vouchExists",
			]);
		}),
	);

	it.effect("dark-ship: flag OFF ⇒ null, and NO trusted source is touched", () =>
		Effect.gen(function* () {
			// Every trusted source is fail-on-contact; reaching one would `die`, so a
			// clean `null` proves the gate short-circuits before any read.
			const standing = yield* standingOf({
				on: false,
				kunye: Layer.succeed(Kunye, {
					karmaOf: () => Effect.die(new Error("flag OFF must not read karma")),
					tierOf: () => Effect.die(new Error("unused")),
					rootOf: (id: string) => Effect.succeed(id),
				}),
				ledger: makeVouchLedgerStub({
					hasActiveFor: () => Effect.die(new Error("flag OFF must not read the vouch ledger")),
				}),
			});
			assert.strictEqual(standing, null);
		}),
	);

	it.effect("anonymous ⇒ wire UNAUTHORIZED before the flag or any read", () =>
		Effect.gen(function* () {
			const exit = yield* standingOf({on: true, user: undefined}).pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) {
				const error = Cause.findErrorOption(exit.cause);
				assert.isTrue(error._tag === "Some");
				if (error._tag === "Some") {
					assert.strictEqual((error.value as {code: string}).code, "UNAUTHORIZED");
				}
			}
		}),
	);
});
