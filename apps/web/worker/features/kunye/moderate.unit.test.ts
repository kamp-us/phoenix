/**
 * `Moderate` capability coverage (ADR 0107 §4, ADR 0098 §2): a non-holder and the
 * anonymous actor must fail the SAME invisible `Denied`, so a non-moderator cannot tell
 * itself apart from anonymous. Ports are scripted, no DB; the real-D1 write→read seam is
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
import {allModerators, Moderate, moderatorOf, moderatorsAmong} from "./moderate.ts";

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
				subjectsOf: ({relation, object}) =>
					Effect.succeed(
						new Set(relation === "moderates" && object.type === "platform" ? holders : []),
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

// The fixture answers membership off the same holder set `has` proves against, so the
// batched and single reads agree.
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
			subjectsOf: ({relation, object}) =>
				Effect.succeed(
					new Set(relation === "moderates" && object.type === "platform" ? holders : []),
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

// The OPEN-set enumeration (#1699) the membership pair can't answer: the whole subject
// set with no candidates up front.
describe("allModerators", () => {
	const storeOf = (holders: ReadonlyArray<string>) =>
		Effect.provideService(RelationStore, {
			has: () => Effect.die(new Error("allModerators enumerates via subjectsOf, not has")),
			hasSubjects: () =>
				Effect.die(new Error("allModerators enumerates via subjectsOf, not hasSubjects")),
			subjectsOf: ({relation, object}) =>
				Effect.succeed(
					new Set(relation === "moderates" && object.type === "platform" ? holders : []),
				),
		});

	it("enumerates every subject holding the moderates tuple", () => {
		const mods = Effect.runSync(allModerators().pipe(storeOf(["u-mod1", "u-mod2"])));
		assert.deepStrictEqual([...mods].sort(), ["u-mod1", "u-mod2"]);
	});

	it("is empty when no one moderates", () => {
		const mods = Effect.runSync(allModerators().pipe(storeOf([])));
		assert.strictEqual(mods.size, 0);
	});
});
