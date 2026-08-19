/**
 * The self-scoped authorship-standing read (#1316): the aggregate the status block
 * consumes about ITSELF. The read is keyed on `CurrentUser` and takes no input arg,
 * so nobody can read another user's self-status, and the payload type carries only
 * aggregate scalars — there is no identity field to leak.
 */

import {assert, describe, it} from "@effect/vitest";
import {CurrentUser, type CurrentUserInfo} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Cause, Effect, Exit, Layer} from "effect";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {Kunye} from "../kunye/Kunye.ts";
import {KARMA_THRESHOLDS, VOUCH_PROMOTION_KARMA_BAR} from "../kunye/standing.ts";
import {makeVouchLedgerStub} from "../kunye/VouchLedger.testing.ts";
import type {VouchLedger} from "../kunye/VouchLedger.ts";
import {makePasaportStub} from "./Pasaport.testing.ts";
import {queries} from "./queries.ts";
import type {AuthorshipStanding} from "./views.ts";

// Adding any identity field to `AuthorshipStanding` breaks this `extends` both ways
// and is a COMPILE error here, which is what makes the leak unrepresentable.
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

// `tierOf`/`rootOf` die: the standing read only reads karma, so a reached call fails.
const kunyeWithKarma = (karmaById: Record<string, number>): Layer.Layer<Kunye> =>
	Layer.succeed(Kunye, {
		karmaOf: (id: string) => Effect.succeed(karmaById[id] ?? 0),
		tierOf: () => Effect.die(new Error("Kunye.tierOf must not be reached")),
		rootOf: (id: string) => Effect.succeed(id),
	});

const SELF: CurrentUserInfo = {id: "u-self", email: "self@kamp.us", name: "Self", image: null};

const standingOf = (input: {
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
			const standing = (yield* standingOf({vouchExists: true})) as AuthorshipStanding;
			assert.strictEqual(standing.vouchExists, true);
			assert.strictEqual(standing.bar, VOUCH_PROMOTION_KARMA_BAR);
		}),
	);

	it.effect("vouchExists=false ⇒ bar is the full unassisted yazar threshold", () =>
		Effect.gen(function* () {
			const standing = (yield* standingOf({vouchExists: false})) as AuthorshipStanding;
			assert.strictEqual(standing.vouchExists, false);
			assert.strictEqual(standing.bar, KARMA_THRESHOLDS.yazar);
		}),
	);

	it.effect("inReviewCount reflects the reader's own sandboxed-not-removed count", () =>
		Effect.gen(function* () {
			const standing = (yield* standingOf({
				vouchExists: false,
				inReviewCount: 7,
			})) as AuthorshipStanding;
			assert.strictEqual(standing.inReviewCount, 7);
		}),
	);

	it.effect("ONE-WAY-GLASS: the resolved payload carries ONLY aggregate keys", () =>
		Effect.gen(function* () {
			const standing = (yield* standingOf({
				karma: 5,
				vouchExists: true,
				inReviewCount: 1,
			})) as AuthorshipStanding;
			// No identity field is present at runtime either.
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

	it.effect("anonymous ⇒ wire UNAUTHORIZED before any read", () =>
		Effect.gen(function* () {
			const exit = yield* standingOf({user: undefined}).pipe(Effect.exit);
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
