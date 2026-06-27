/**
 * `Vouch` capability coverage (ADR 0107 §2-3, #1206) — the author-vouch right, a
 * `Capability.Level` floored at `yazar`. A yazar discharges `Vouch.require` to a
 * `Grant`; a çaylak, a visitor, and the anonymous actor all fail the public
 * `RequiresLevel` (`FORBIDDEN`, `need: "yazar"`). This is the structural reason a
 * çaylak cannot vouch — and, with a yazar self-vouch being inert (already yazar),
 * the reason self-promotion is impossible across both authority paths.
 *
 * The two ports are scripted (`Kunye` the standing read, `AgentAuthority` fail-closed,
 * `CurrentActor` the actor) — no DB; the real-D1 tier read lives behind `Kunye.tierOf`
 * (its own integration coverage).
 */
import {assert, describe, it} from "@effect/vitest";
import {
	type Actor,
	AgentAuthority,
	CurrentActor,
	type Grant,
	human,
	isGrant,
	unauthenticated,
} from "@kampus/authz";
import {Effect, Exit, Layer} from "effect";
import {RequiresLevel} from "./errors.ts";
import {Kunye} from "./Kunye.ts";
import type {Tier} from "./standing.ts";
import {Vouch, voucherOf} from "./vouch.ts";

// A `Kunye` whose `tierOf` answers the scripted standing for every id; the other
// reads are unreached on the `Vouch.require` path.
const kunyeAt = (tier: Tier): Layer.Layer<Kunye> =>
	Layer.succeed(Kunye, {
		tierOf: () => Effect.succeed(tier),
		karmaOf: () => Effect.die(new Error("Vouch.require must not read karma")),
		rootOf: (id: string) => Effect.succeed(id),
	});

const discharge = (actor: Actor, tier: Tier): Exit.Exit<Grant<Vouch>, RequiresLevel> =>
	Effect.runSyncExit(
		Vouch.require.pipe(
			Effect.provideService(CurrentActor, {actor}),
			Effect.provideService(AgentAuthority, {admits: () => Effect.succeed(false)}),
			Effect.provide(kunyeAt(tier)),
		),
	);

describe("Vouch.require", () => {
	it("a yazar discharges a Grant (PASS), carrying the yazar level", () => {
		const exit = discharge(human("u-yazar"), "yazar");
		assert.isTrue(Exit.isSuccess(exit));
		if (Exit.isSuccess(exit)) {
			assert.isTrue(isGrant(exit.value));
			assert.strictEqual(exit.value.scope.capability, "kunye/Vouch");
			assert.strictEqual(exit.value.scope.level, "yazar");
		}
	});

	it("a çaylak is denied RequiresLevel (FORBIDDEN, need yazar) — a çaylak cannot vouch", () => {
		const exit = discharge(human("u-caylak"), "çaylak");
		assert.isTrue(Exit.isFailure(exit));
		assert.match(String(Exit.isFailure(exit) ? exit.cause : ""), /kunye\/RequiresLevel/);
	});

	it("a visitor is denied RequiresLevel", () => {
		const exit = discharge(human("u-visitor"), "visitor");
		assert.isTrue(Exit.isFailure(exit));
		assert.match(String(Exit.isFailure(exit) ? exit.cause : ""), /kunye\/RequiresLevel/);
	});

	it("the anonymous actor is denied RequiresLevel", () => {
		const exit = discharge(unauthenticated, "yazar");
		assert.isTrue(Exit.isFailure(exit));
		assert.match(String(Exit.isFailure(exit) ? exit.cause : ""), /kunye\/RequiresLevel/);
	});

	it("RequiresLevel carries the public FORBIDDEN wire code with need=yazar", () => {
		const err = new RequiresLevel({message: "x", need: "yazar"});
		assert.strictEqual(err._tag, "kunye/RequiresLevel");
		assert.strictEqual(err.need, "yazar");
	});

	it("voucherOf reads the vouching actor id off a discharged grant", () => {
		const exit = discharge(human("u-yazar"), "yazar");
		assert.isTrue(Exit.isSuccess(exit));
		if (Exit.isSuccess(exit)) {
			assert.strictEqual(Effect.runSync(voucherOf(exit.value)), "u-yazar");
		}
	});
});
