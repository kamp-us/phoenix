/**
 * The divan disjunctive gate through the REAL capability seams, not a re-implemented
 * `tier === "yazar" || isMod` check. The matrix proves both arms AND their independence: a
 * mod who is NOT a yazar still passes, a yazar who is NOT a mod still passes; a çaylak, a
 * visitor and the anonymous actor get the invisible `Denied`. All four ports are scripted.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	type Actor,
	AgentAuthority,
	CurrentActor,
	type Grant,
	human,
	RelationStore,
	unauthenticated,
} from "@kampus/authz";
import {Effect, Exit} from "effect";
import type {Denied, RequiresLevel} from "../kunye/errors.ts";
import {Kunye} from "../kunye/Kunye.ts";
import type {Tier} from "../kunye/standing.ts";
import {DivanStanding, requireDivanAccess, ViewDivan} from "./gate.ts";

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
				hasSubjects: ({subjects, relation, object}) =>
					Effect.succeed(
						new Set(
							relation === "moderates" && object.type === "platform"
								? subjects.filter((s) => (opts.mods ?? []).includes(s))
								: [],
						),
					),
				subjectsOf: ({relation, object}) =>
					Effect.succeed(
						new Set(
							relation === "moderates" && object.type === "platform" ? (opts.mods ?? []) : [],
						),
					),
			}),
		),
	);

describe("divan gate — yazar OR mod, collapse-to-allow", () => {
	it("a yazar (not a mod) is allowed — the DivanStanding arm alone passes", () => {
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
		// `yield* ViewDivan` would be a compile error without the provided grant, so reaching
		// "reached" proves the gate supplied the proof rather than returning a boolean.
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
				Effect.provideService(RelationStore, {
					has: () => Effect.succeed(false),
					hasSubjects: () => Effect.succeed(new Set<string>()),
					subjectsOf: () => Effect.succeed(new Set<string>()),
				}),
			),
		);
		assert.isTrue(Exit.isSuccess(exit));
	});
});

const standing = (actor: Actor, tier: Tier): Exit.Exit<Grant<DivanStanding>, RequiresLevel> =>
	Effect.runSyncExit(
		DivanStanding.require.pipe(
			Effect.provideService(CurrentActor, {actor}),
			Effect.provideService(AgentAuthority, {admits: () => Effect.succeed(false)}),
			Effect.provideService(Kunye, {
				tierOf: () => Effect.succeed(tier),
				karmaOf: () => Effect.die(new Error("standing must not read karma")),
				rootOf: (id: string) => Effect.succeed(id),
			}),
		),
	);

describe("DivanStanding — the divan's own yazar floor (no longer borrowing OpenTerm)", () => {
	it("a yazar discharges the grant", () => {
		assert.isTrue(Exit.isSuccess(standing(human("u"), "yazar")));
	});

	it("a çaylak is below the floor — denied", () => {
		assert.isTrue(Exit.isFailure(standing(human("u"), "çaylak")));
	});

	it("a visitor is below the floor — denied", () => {
		assert.isTrue(Exit.isFailure(standing(human("u"), "visitor")));
	});

	it("the anonymous actor is denied regardless of scripted standing", () => {
		assert.isTrue(Exit.isFailure(standing(unauthenticated, "yazar")));
	});

	it("the denial names the yazar floor (RequiresLevel, FORBIDDEN)", () => {
		const exit = standing(human("u"), "çaylak");
		assert.isTrue(Exit.isFailure(exit));
		assert.match(String(Exit.isFailure(exit) ? exit.cause : ""), /kunye\/RequiresLevel/);
	});
});
