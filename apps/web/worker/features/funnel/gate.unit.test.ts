/**
 * The funnel access gate (#1589) through the REAL capability seams — not a
 * re-implemented `isMod` check. {@link requireFunnelAccess} discharges
 * {@link ViewFunnel}, whose check runs a genuine `Moderate.over(platform)` discharge
 * (the `moderates` `Relation`) collapsed to a boolean. The matrix proves the mod arm
 * grants and every non-mod (a signed-in non-mod, the anonymous actor) is denied the
 * invisible `Denied`.
 *
 * The ports are scripted (`RelationStore` the moderates tuple, `AgentAuthority`
 * fail-closed, `CurrentActor` the actor) — no DB.
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
import {requireFunnelAccess, ViewFunnel} from "./gate.ts";

/** Run the gate over `body = succeed("ok")` for one actor, scripting the mod set. */
const access = (
	actor: Actor,
	opts: {readonly mods?: ReadonlyArray<string>} = {},
): Exit.Exit<"ok", Denied> =>
	Effect.runSyncExit(
		requireFunnelAccess(Effect.succeed("ok" as const)).pipe(
			Effect.provideService(CurrentActor, {actor}),
			Effect.provideService(AgentAuthority, {admits: () => Effect.succeed(false)}),
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
			}),
		),
	);

describe("funnel gate — platform-moderation only", () => {
	it("a mod is allowed — the Moderate arm passes", () => {
		assert.isTrue(Exit.isSuccess(access(human("u"), {mods: ["u"]})));
	});

	it("a signed-in non-mod is denied", () => {
		assert.isTrue(Exit.isFailure(access(human("u"), {mods: []})));
	});

	it("the anonymous actor is denied", () => {
		assert.isTrue(Exit.isFailure(access(unauthenticated, {mods: ["anon"]})));
	});

	it("the denial is the invisible Denied (UNAUTHORIZED)", () => {
		const exit = access(human("u"), {mods: []});
		assert.isTrue(Exit.isFailure(exit));
		assert.match(String(Exit.isFailure(exit) ? exit.cause : ""), /kunye\/Denied/);
	});

	it("an allowed read threads a ViewFunnel grant into the body's R (enforcement-by-R)", () => {
		// `yield* ViewFunnel` would be a compile error without the provided grant — so
		// reaching "reached" proves the gate supplied the proof, not just a boolean.
		const exit = Effect.runSyncExit(
			requireFunnelAccess(
				Effect.gen(function* () {
					yield* ViewFunnel;
					return "reached" as const;
				}),
			).pipe(
				Effect.provideService(CurrentActor, {actor: human("u")}),
				Effect.provideService(AgentAuthority, {admits: () => Effect.succeed(false)}),
				Effect.provideService(RelationStore, {
					has: () => Effect.succeed(true),
					hasSubjects: ({subjects}) => Effect.succeed(new Set(subjects)),
				}),
			),
		);
		assert.isTrue(Exit.isSuccess(exit));
	});
});
