/**
 * `divan.pendingCount` — the topbar badge's read (#6760), driven through the REAL
 * `requireDivanAccess` gate: a yazar is served and a çaylak draws the invisible `Denied`
 * `divan.roster` gives it, which proves the badge rides the gate rather than a
 * `tier === "yazar"` check. The gate's other arms are `gate.unit.test.ts`'s. The count
 * itself comes off a stubbed {@link Divan}, so what is asserted is the gate + shape, not
 * the backlog predicate (that is `Divan.unit.test.ts`'s).
 */
import {assert, describe, it} from "@effect/vitest";
import {type Actor, AgentAuthority, CurrentActor, human, RelationStore} from "@kampus/authz";
import {Effect, Exit, Layer} from "effect";
import type {Denied} from "../kunye/errors.ts";
import {Kunye} from "../kunye/Kunye.ts";
import type {Tier} from "../kunye/standing.ts";
import {Divan} from "./Divan.ts";
import {queries} from "./queries.ts";

const pendingCountQuery = queries["divan.pendingCount"];

const divanStub = (count: number): Layer.Layer<Divan> =>
	// biome-ignore lint/plugin: a service double — only the whole-roster total is on this path.
	Layer.succeed(Divan, {
		pendingTotal: () => Effect.succeed(count),
	} as unknown as typeof Divan.Service);

const resolveAs = (
	actor: Actor,
	opts: {
		readonly tier?: Tier;
		readonly mods?: ReadonlyArray<string>;
		readonly count?: number;
	} = {},
): Exit.Exit<
	{readonly __typename: "DivanPending"; readonly id: string; readonly count: number},
	Denied
> =>
	Effect.runSyncExit(
		pendingCountQuery.resolve({select: []}).pipe(
			Effect.provide(divanStub(opts.count ?? 0)),
			Effect.provideService(CurrentActor, {actor}),
			Effect.provideService(AgentAuthority, {admits: () => Effect.succeed(false)}),
			Effect.provideService(Kunye, {
				tierOf: () => Effect.succeed(opts.tier ?? ("visitor" as const)),
				karmaOf: (_id: string) => Effect.die(new Error("divan gate must not read karma")),
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

describe("divan.pendingCount — the divan gate, not a tier equality (#6760)", () => {
	it("a yazar reads the pending singleton with the service's count", () => {
		const exit = resolveAs(human("u"), {tier: "yazar", count: 7});
		assert.isTrue(Exit.isSuccess(exit));
		if (!Exit.isSuccess(exit)) return;
		assert.deepStrictEqual(exit.value, {
			__typename: "DivanPending",
			id: "pending",
			count: 7,
		});
	});

	it("a çaylak with no moderation is denied at the wire, exactly as divan.roster denies", () => {
		assert.isTrue(Exit.isFailure(resolveAs(human("u"), {tier: "çaylak"})));
	});
});
