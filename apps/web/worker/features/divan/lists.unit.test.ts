/**
 * `divan.roster` — the viewer-scoped `viewerVouched` field (#7373), driven through the
 * REAL `requireDivanAccess` gate. The `VouchLedger` double dies on any method but
 * `candidatesVouchedBy`, so "the whole roster is marked from ONE ledger read, never a
 * per-row `has`" (ADR 0021's no-waterfalls contract) is asserted by construction.
 *
 * The gate disjunction itself is `gate.unit.test.ts`'s; the backlog predicate is
 * `Divan.unit.test.ts`'s.
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
import {CurrentUser} from "@kampus/fate-effect";
import {Effect, Exit, Layer} from "effect";
import {UserId} from "../../lib/ids.ts";
import type {Denied} from "../kunye/errors.ts";
import {Kunye} from "../kunye/Kunye.ts";
import type {Tier} from "../kunye/standing.ts";
import {makeVouchLedgerStub} from "../kunye/VouchLedger.testing.ts";
import {Divan} from "./Divan.ts";
import {lists} from "./lists.ts";
import type {DivanRosterRow} from "./roster.ts";
import type {DivanCaylak} from "./views.ts";

const rosterList = lists["divan.roster"];

const rosterRow = (authorId: string): DivanRosterRow => ({
	authorId: UserId.make(authorId),
	username: authorId,
	displayName: null,
	totalKarma: 0,
	definitionCount: 1,
	postCount: 0,
	commentCount: 0,
	totalCount: 1,
});

const divanStub = (authorIds: ReadonlyArray<string>): Layer.Layer<Divan> =>
	// biome-ignore lint/plugin: a service double — only the roster read is on this path.
	Layer.succeed(Divan, {
		roster: () => Effect.succeed(authorIds.map(rosterRow)),
	} as unknown as typeof Divan.Service);

const resolveAs = (
	actor: Actor,
	opts: {
		readonly tier?: Tier;
		readonly mods?: ReadonlyArray<string>;
		readonly roster?: ReadonlyArray<string>;
		readonly vouched?: ReadonlyArray<string>;
		readonly ledgerCalls?: Array<string>;
	} = {},
): Exit.Exit<{readonly items: ReadonlyArray<{readonly node: DivanCaylak}>}, Denied> =>
	Effect.runSyncExit(
		rosterList.resolve({args: {first: 50}, select: []}).pipe(
			Effect.provide(
				Layer.mergeAll(
					divanStub(opts.roster ?? []),
					makeVouchLedgerStub({
						candidatesVouchedBy: (voucherId: string) => {
							opts.ledgerCalls?.push(voucherId);
							return Effect.succeed(opts.vouched ?? []);
						},
					}),
				),
			),
			Effect.provideService(CurrentUser, {
				user:
					actor._tag === "Authenticated" && actor.principal._tag === "Human"
						? ({id: actor.principal.id} as never)
						: undefined,
			}),
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
	) as Exit.Exit<{readonly items: ReadonlyArray<{readonly node: DivanCaylak}>}, Denied>;

const vouchedFlags = (
	exit: Exit.Exit<{readonly items: ReadonlyArray<{readonly node: DivanCaylak}>}, Denied>,
): ReadonlyArray<readonly [string, boolean]> => {
	assert.isTrue(Exit.isSuccess(exit));
	if (!Exit.isSuccess(exit)) return [];
	return exit.value.items.map((i) => [i.node.authorId, i.node.viewerVouched] as const);
};

describe("divan.roster — viewerVouched marks the reader's own vouches (#7373)", () => {
	it("marks exactly the çaylaks the reading yazar already holds a vouch row for", () => {
		const exit = resolveAs(human("u-yazar"), {
			tier: "yazar",
			roster: ["c-1", "c-2", "c-3"],
			vouched: ["c-2"],
		});
		assert.deepStrictEqual(vouchedFlags(exit), [
			["c-1", false],
			["c-2", true],
			["c-3", false],
		]);
	});

	it("reads the ledger ONCE for the whole roster, keyed on the READING actor", () => {
		const ledgerCalls: string[] = [];
		resolveAs(human("u-yazar"), {
			tier: "yazar",
			roster: ["c-1", "c-2", "c-3"],
			vouched: [],
			ledgerCalls,
		});
		assert.deepStrictEqual(ledgerCalls, ["u-yazar"]);
	});

	it("a moderator who has vouched for nobody gets an all-false roster, not a denial", () => {
		const exit = resolveAs(human("u-mod"), {
			tier: "çaylak",
			mods: ["u-mod"],
			roster: ["c-1"],
			vouched: [],
		});
		assert.deepStrictEqual(vouchedFlags(exit), [["c-1", false]]);
	});

	it("an ungated reader is still denied — the field widens nobody's access", () => {
		assert.isTrue(Exit.isFailure(resolveAs(unauthenticated)));
		assert.isTrue(Exit.isFailure(resolveAs(human("u"), {tier: "çaylak"})));
	});
});
