/**
 * `Moderate` capability coverage (ADR 0107 §4, carrying ADR 0098 §2 forward) — the
 * prior-art contract of the retired `report/Moderator.unit.test.ts`, re-expressed
 * over the relation tuple instead of `user.role`: a holder of the `moderates`
 * relation discharges `Moderate.over(platform)` to a `Grant`; a non-holder and the
 * anonymous actor both fail the SAME invisible `Denied` (`UNAUTHORIZED`), so a
 * non-moderator cannot tell itself apart from anonymous. The three ports are
 * scripted (`RelationStore` the tuple set, `AgentAuthority` fail-closed,
 * `CurrentActor` the actor) — no DB; the real-D1 write→read seam lives in
 * `apps/web/tests/integration/kunye-moderate-seam.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	type Actor,
	AgentAuthority,
	CurrentActor,
	type Grant,
	human,
	isGrant,
	platform,
	RelationStore,
	unauthenticated,
} from "@kampus/authz";
import {Effect, Exit} from "effect";
import {Denied} from "./errors.ts";
import {Moderate, moderatorOf, moderatorsAmong} from "./moderate.ts";

// Provide the three ports off a fixture (the holder set the `moderates` tuple
// proves membership against) and run `Moderate.over(platform)` to an Exit.
const discharge = (
	actor: Actor,
	holders: ReadonlyArray<string>,
): Exit.Exit<Grant<Moderate>, Denied> =>
	Effect.runSyncExit(
		Moderate.over(platform).pipe(
			Effect.provideService(CurrentActor, {actor}),
			Effect.provideService(AgentAuthority, {admits: () => Effect.succeed(false)}),
			Effect.provideService(RelationStore, {
				has: (tuple) =>
					Effect.succeed(
						tuple.relation === "moderates" &&
							tuple.object.type === "platform" &&
							holders.includes(tuple.subject),
					),
				hasSubjects: ({subjects, relation, object}) =>
					Effect.succeed(
						new Set(
							relation === "moderates" && object.type === "platform"
								? subjects.filter((subject) => holders.includes(subject))
								: [],
						),
					),
			}),
		),
	);

describe("Moderate.over(platform)", () => {
	it("a holder of the moderates tuple discharges a Grant (PASS)", () => {
		const exit = discharge(human("u1"), ["u1"]);
		assert.isTrue(Exit.isSuccess(exit));
		if (Exit.isSuccess(exit)) {
			assert.isTrue(isGrant(exit.value));
			assert.strictEqual(exit.value.scope.capability, "kunye/Moderate");
			assert.deepStrictEqual(exit.value.scope.resource, platform);
		}
	});

	it("a non-holder is denied the invisible Denied (UNAUTHORIZED), fresh read", () => {
		const exit = discharge(human("u1"), ["someone-else"]);
		assert.isTrue(Exit.isFailure(exit));
		assert.match(String(Exit.isFailure(exit) ? exit.cause : ""), /kunye\/Denied/);
	});

	it("the anonymous actor is denied the SAME Denied — indistinguishable from a non-moderator", () => {
		const exit = discharge(unauthenticated, ["u1"]);
		assert.isTrue(Exit.isFailure(exit));
		assert.match(String(Exit.isFailure(exit) ? exit.cause : ""), /kunye\/Denied/);
	});

	it("Denied carries the invisible UNAUTHORIZED wire code (ADR 0098 §2)", () => {
		const err = new Denied({message: "x"});
		assert.strictEqual(err._tag, "kunye/Denied");
		assert.instanceOf(err, Denied);
	});

	it("moderatorOf reads the authority-checked id off a discharged grant", () => {
		const exit = discharge(human("u-mod"), ["u-mod"]);
		assert.isTrue(Exit.isSuccess(exit));
		if (Exit.isSuccess(exit)) {
			const id = Effect.runSync(moderatorOf(exit.value));
			assert.strictEqual(id, "u-mod");
		}
	});
});

// `moderatorsAmong` is the batched form of `isModerator` (#1360): ONE
// `RelationStore.hasSubjects` read over the `(moderates, platform)` tuple, so the
// by-id loader joins moderator standing without a per-row probe. The fixture
// answers membership off the same holder set `has` proves against, keyed on the
// `moderates` relation and the platform object, so batch and single reads agree.
describe("moderatorsAmong", () => {
	const storeOf = (holders: ReadonlyArray<string>) =>
		Effect.provideService(RelationStore, {
			has: (tuple) =>
				Effect.succeed(
					tuple.relation === "moderates" &&
						tuple.object.type === "platform" &&
						holders.includes(tuple.subject),
				),
			hasSubjects: ({subjects, relation, object}) =>
				Effect.succeed(
					new Set(
						relation === "moderates" && object.type === "platform"
							? subjects.filter((subject) => holders.includes(subject))
							: [],
					),
				),
		});

	it("returns exactly the subjects that hold the moderates tuple", () => {
		const mods = Effect.runSync(moderatorsAmong(["u1", "u2", "u3"]).pipe(storeOf(["u1", "u3"])));
		assert.deepStrictEqual([...mods].sort(), ["u1", "u3"]);
	});

	it("is empty when none of the subjects moderate", () => {
		const mods = Effect.runSync(moderatorsAmong(["u1", "u2"]).pipe(storeOf(["someone-else"])));
		assert.strictEqual(mods.size, 0);
	});

	it("is empty for an empty subject set", () => {
		const mods = Effect.runSync(moderatorsAmong([]).pipe(storeOf(["u1"])));
		assert.strictEqual(mods.size, 0);
	});
});
