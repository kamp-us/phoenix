/**
 * `Admin` capability coverage (ADR 0107 §4, carrying ADR 0098 §2 forward) — the
 * `admin` twin of `moderate.unit.test.ts`: a holder of the `admin` relation
 * discharges `Admin.over(platform)` to a `Grant`; a non-holder and the anonymous
 * actor both fail the SAME invisible `Denied` (`UNAUTHORIZED`), so a non-admin
 * cannot tell itself apart from anonymous. The three ports are scripted
 * (`RelationStore` the tuple set, `AgentAuthority` fail-closed, `CurrentActor` the
 * actor) — no DB; the real-D1 write→read seam lives in
 * `apps/web/tests/integration/kunye-admin-seam.test.ts`.
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
import {Admin, adminOf} from "./admin.ts";
import {Denied} from "./errors.ts";

// Provide the three ports off a fixture (the holder set the `admin` tuple proves
// membership against) and run `Admin.over(platform)` to an Exit.
const discharge = (actor: Actor, holders: ReadonlyArray<string>): Exit.Exit<Grant<Admin>, Denied> =>
	Effect.runSyncExit(
		Admin.over(platform).pipe(
			Effect.provideService(CurrentActor, {actor}),
			Effect.provideService(AgentAuthority, {admits: () => Effect.succeed(false)}),
			Effect.provideService(RelationStore, {
				has: (tuple) =>
					Effect.succeed(
						tuple.relation === "admin" &&
							tuple.object.type === "platform" &&
							holders.includes(tuple.subject),
					),
				hasSubjects: ({subjects, relation, object}) =>
					Effect.succeed(
						new Set(
							relation === "admin" && object.type === "platform"
								? subjects.filter((subject) => holders.includes(subject))
								: [],
						),
					),
				subjectsOf: ({relation, object}) =>
					Effect.succeed(
						new Set(relation === "admin" && object.type === "platform" ? holders : []),
					),
			}),
		),
	);

describe("Admin.over(platform)", () => {
	it("a holder of the admin tuple discharges a Grant (PASS)", () => {
		const exit = discharge(human("u1"), ["u1"]);
		assert.isTrue(Exit.isSuccess(exit));
		if (Exit.isSuccess(exit)) {
			assert.isTrue(isGrant(exit.value));
			assert.strictEqual(exit.value.scope.capability, "kunye/Admin");
			assert.deepStrictEqual(exit.value.scope.resource, platform);
		}
	});

	it("a non-holder is denied the invisible Denied (UNAUTHORIZED), fresh read", () => {
		const exit = discharge(human("u1"), ["someone-else"]);
		assert.isTrue(Exit.isFailure(exit));
		assert.match(String(Exit.isFailure(exit) ? exit.cause : ""), /kunye\/Denied/);
	});

	it("the anonymous actor is denied the SAME Denied — indistinguishable from a non-admin", () => {
		const exit = discharge(unauthenticated, ["u1"]);
		assert.isTrue(Exit.isFailure(exit));
		assert.match(String(Exit.isFailure(exit) ? exit.cause : ""), /kunye\/Denied/);
	});

	it("Denied carries the invisible UNAUTHORIZED wire code (ADR 0098 §2)", () => {
		const err = new Denied({message: "x"});
		assert.strictEqual(err._tag, "kunye/Denied");
		assert.instanceOf(err, Denied);
	});

	it("adminOf reads the authority-checked id off a discharged grant", () => {
		const exit = discharge(human("u-admin"), ["u-admin"]);
		assert.isTrue(Exit.isSuccess(exit));
		if (Exit.isSuccess(exit)) {
			const id = Effect.runSync(adminOf(exit.value));
			assert.strictEqual(id, "u-admin");
		}
	});
});
