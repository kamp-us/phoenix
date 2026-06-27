/**
 * The divan disjunctive gate (#1287, epic #1202) through the REAL capability seams
 * — not a re-implemented `tier === "yazar" || isMod` check. {@link requireDivanAccess}
 * discharges `ViewDivan`, whose check OR-s two genuine discharges: `OpenTerm.require`
 * (the Authorship yazar-floor `Level`) and `Moderate.over(platform)` (the `moderates`
 * `Relation`). The matrix proves both arms AND the disjunction independence: a mod who
 * is NOT a yazar still passes, a yazar who is NOT a mod still passes; a çaylak, a
 * visitor, and the anonymous actor are denied the invisible `Denied`.
 *
 * All four ports are scripted (`Kunye` standing, `RelationStore` the moderates tuple,
 * `AgentAuthority` fail-closed, `CurrentActor` the actor) — no DB.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	type Actor,
	AgentAuthority,
	CurrentActor,
	human,
	RelationStore,
	unauthenticated,
} from "@kampus/authz";
import {Effect, Exit} from "effect";
import type {Denied} from "../kunye/errors.ts";
import {Kunye} from "../kunye/Kunye.ts";
import type {Tier} from "../kunye/standing.ts";
import {requireDivanAccess, ViewDivan} from "./gate.ts";

/** Run the gate over `body = succeed("ok")` for one actor, scripting standing + mods. */
const access = (
	actor: Actor,
	opts: {readonly tier?: Tier; readonly mods?: ReadonlyArray<string>} = {},
): Exit.Exit<"ok", Denied> =>
	Effect.runSyncExit(
		requireDivanAccess(Effect.succeed("ok" as const)).pipe(
			Effect.provideService(CurrentActor, {actor}),
			Effect.provideService(AgentAuthority, {admits: () => Effect.succeed(false)}),
			Effect.provideService(Kunye, {
				tierOf: () => Effect.succeed(opts.tier ?? "visitor"),
				karmaOf: () => Effect.die(new Error("divan gate must not read karma")),
				rootOf: (id: string) => Effect.succeed(id),
			}),
			Effect.provideService(RelationStore, {
				has: (tuple) =>
					Effect.succeed(
						tuple.relation === "moderates" &&
							tuple.object.type === "platform" &&
							(opts.mods ?? []).includes(tuple.subject),
					),
			}),
		),
	);

describe("divan gate — yazar OR mod, collapse-to-allow", () => {
	it("a yazar (not a mod) is allowed — the Authorship arm alone passes", () => {
		assert.isTrue(Exit.isSuccess(access(human("u"), {tier: "yazar", mods: []})));
	});

	it("a mod (not a yazar) is allowed — the Moderate arm alone passes", () => {
		assert.isTrue(Exit.isSuccess(access(human("u"), {tier: "çaylak", mods: ["u"]})));
	});

	it("a mod who is a visitor is still allowed — moderation needs no standing", () => {
		assert.isTrue(Exit.isSuccess(access(human("u"), {tier: "visitor", mods: ["u"]})));
	});

	it("a yazar who is also a mod is allowed (both arms pass)", () => {
		assert.isTrue(Exit.isSuccess(access(human("u"), {tier: "yazar", mods: ["u"]})));
	});

	it("a çaylak (no mod tuple) is denied — below the yazar floor, not a mod", () => {
		assert.isTrue(Exit.isFailure(access(human("u"), {tier: "çaylak", mods: []})));
	});

	it("a visitor is denied", () => {
		assert.isTrue(Exit.isFailure(access(human("u"), {tier: "visitor", mods: []})));
	});

	it("the anonymous actor is denied", () => {
		assert.isTrue(Exit.isFailure(access(unauthenticated, {tier: "yazar", mods: ["anon"]})));
	});

	it("the denial is the invisible Denied (UNAUTHORIZED)", () => {
		const exit = access(human("u"), {tier: "çaylak", mods: []});
		assert.isTrue(Exit.isFailure(exit));
		assert.match(String(Exit.isFailure(exit) ? exit.cause : ""), /kunye\/Denied/);
	});

	it("an allowed read threads a ViewDivan grant into the body's R (enforcement-by-R)", () => {
		// `yield* ViewDivan` would be a compile error without the provided grant — so a
		// reached "reached" proves the gate supplied the proof, not just returned a boolean.
		const exit = Effect.runSyncExit(
			requireDivanAccess(
				Effect.gen(function* () {
					yield* ViewDivan;
					return "reached" as const;
				}),
			).pipe(
				Effect.provideService(CurrentActor, {actor: human("u")}),
				Effect.provideService(AgentAuthority, {admits: () => Effect.succeed(false)}),
				Effect.provideService(Kunye, {
					tierOf: () => Effect.succeed("yazar" as Tier),
					karmaOf: () => Effect.die(new Error("x")),
					rootOf: (id: string) => Effect.succeed(id),
				}),
				Effect.provideService(RelationStore, {has: () => Effect.succeed(false)}),
			),
		);
		assert.isTrue(Exit.isSuccess(exit));
	});
});
