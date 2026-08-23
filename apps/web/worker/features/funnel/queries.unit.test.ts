/**
 * The cohort-section resolvers (#7031) across their three seams (ADR 0082): the
 * `requireFunnelAccess` capability gate through the REAL authz seams, the default-off
 * `phoenix-funnel-cohort` dark-ship short-circuit (flag off ⇒ no cohort read runs), and the
 * flag-on hydration over a substituted `Funnel`. All through `resolveWire`, so assertions
 * land on the WIRE codes.
 */
import {assert, describe, it} from "@effect/vitest";
import {AgentAuthority, CurrentActor, human, RelationStore, unauthenticated} from "@kampus/authz";
import {CurrentUser} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Cause, Effect, Exit, Layer} from "effect";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {Flags} from "../flagship/Flags.ts";
import {makeFunnelStub} from "./Funnel.testing.ts";
import {lists, queries} from "./queries.ts";

const MODS: ReadonlyArray<string> = ["u-mod"];

/** The REAL gate seams, provisioned exactly as `gate.unit.test.ts` proves them. */
const relationStore = (mods: ReadonlyArray<string>): typeof RelationStore.Service => ({
	has: (tuple) =>
		Effect.succeed(
			tuple.relation === "moderates" &&
				tuple.object.type === "platform" &&
				mods.includes(tuple.subject),
		),
	hasSubjects: ({subjects, relation, object}) =>
		Effect.succeed(
			new Set(
				relation === "moderates" && object.type === "platform"
					? subjects.filter((s) => mods.includes(s))
					: [],
			),
		),
	subjectsOf: ({relation, object}) =>
		Effect.succeed(
			new Set(relation === "moderates" && object.type === "platform" ? [...mods] : []),
		),
});

const flagsStub = (on: boolean): Layer.Layer<Flags> =>
	Layer.succeed(Flags, {
		getBoolean: () => Effect.succeed(on),
		getString: () => Effect.die("getString not exercised"),
		getNumber: () => Effect.die("getNumber not exercised"),
		getObject: () => Effect.die("getObject not exercised"),
	} as typeof Flags.Service);

const MOD_VIEWER = {id: "u-mod", email: "mod@example.com", name: "mod"};

// A unit test drives no real isolate; anything touching the alchemy runtime sees this stub.
const runtimeContextStub: BaseRuntimeContext = {
	Type: "funnel-cohorts-test",
	id: "funnel-cohorts-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

const cohortsFixture = {
	weeks: [
		{
			cohortWeek: "2026-08-03",
			signedUp: 2,
			returnedDays2to7: 0,
			firstContributed7d: 1,
			vouched7d: 1,
			promoted7d: 0,
			d1Returned: 1,
			d7Returned: 1,
			d1ReturnRate: 0.5,
			d7ReturnRate: 0.5,
		},
	],
	unmeasurable: {foundingPromotionsUnmeasurable: 2, vouchEvidenceUnmeasurable: 1},
};

const rollupsFixture = [
	{
		cohortWeek: "2026-07-27",
		signedUp: 4,
		returnedDays2to7: 2,
		firstContributed7d: 1,
		vouched7d: 1,
		promoted7d: 1,
		d1Returned: 2,
		d7Returned: 3,
		d1ReturnRate: 0.5,
		d7ReturnRate: 0.75,
	},
];

// Dies on contact unless overridden, so a passing flag-off test proves no cohort read ran.
const funnelWithCohorts = () =>
	makeFunnelStub({
		cohorts: () => Effect.succeed(cohortsFixture),
		cohortRollups: () => Effect.succeed(rollupsFixture),
	});

/** A mod session: the gate's Moderate arm passes and the flags context reads CurrentUser. */
const modProvisions = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.provideService(CurrentActor, {actor: human("u-mod")}),
		Effect.provideService(AgentAuthority, {admits: () => Effect.succeed(false)}),
		Effect.provideService(RelationStore, relationStore(MODS)),
		Effect.provideService(CurrentUser, {user: MOD_VIEWER}),
		Effect.provideService(RuntimeContext, runtimeContextStub),
	);

const anonProvisions = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.provideService(CurrentActor, {actor: unauthenticated}),
		Effect.provideService(AgentAuthority, {admits: () => Effect.succeed(false)}),
		Effect.provideService(RelationStore, relationStore([])),
		Effect.provideService(CurrentUser, {user: undefined}),
		Effect.provideService(RuntimeContext, runtimeContextStub),
	);

const COHORTS_SELECT = [
	"id",
	"enabled",
	"foundingPromotionsUnmeasurable",
	"vouchEvidenceUnmeasurable",
] as const;

const WEEK_SELECT = [
	"id",
	"signedUp",
	"returnedDays2to7",
	"firstContributed7d",
	"vouched7d",
	"promoted7d",
	"d1Returned",
	"d7Returned",
	"d1ReturnRate",
	"d7ReturnRate",
] as const;

const wireCodeOf = (cause: Cause.Cause<unknown>): unknown => {
	const error = Cause.findErrorOption(cause);
	return error._tag === "Some" ? (error.value as {code?: unknown}).code : undefined;
};

describe("funnel cohort resolvers — gate, dark-ship flag, hydration", () => {
	it.effect("a non-mod is denied with the invisible UNAUTHORIZED before any cohort read", () =>
		Effect.gen(function* () {
			const exit = yield* resolveWire(queries["funnel.cohorts"], {
				args: undefined,
				select: COHORTS_SELECT,
			}).pipe(
				anonProvisions,
				Effect.provide(Layer.mergeAll(flagsStub(true), funnelWithCohorts())),
				Effect.exit,
			);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "UNAUTHORIZED");
		}),
	);

	it.effect("with the flag OFF a mod gets the dark report and no cohort read runs", () =>
		Effect.gen(function* () {
			const report = yield* resolveWire(queries["funnel.cohorts"], {
				args: undefined,
				select: COHORTS_SELECT,
			}).pipe(modProvisions, Effect.provide(Layer.mergeAll(flagsStub(false), makeFunnelStub())));
			assert.deepStrictEqual(report, {
				__typename: "FunnelCohorts",
				id: "cohorts",
				enabled: false,
				foundingPromotionsUnmeasurable: 0,
				vouchEvidenceUnmeasurable: 0,
			});
			const weeks = yield* resolveWire(lists["funnel.cohortWeeks"], {
				args: {},
				select: WEEK_SELECT,
			}).pipe(modProvisions, Effect.provide(Layer.mergeAll(flagsStub(false), makeFunnelStub())));
			assert.deepStrictEqual(weeks.items, []);
			const rollups = yield* resolveWire(lists["funnel.cohortRollups"], {
				args: {},
				select: WEEK_SELECT,
			}).pipe(modProvisions, Effect.provide(Layer.mergeAll(flagsStub(false), makeFunnelStub())));
			assert.deepStrictEqual(rollups.items, []);
		}),
	);

	it.effect("with the flag ON a mod gets the holes plus both week series", () =>
		Effect.gen(function* () {
			const report = yield* resolveWire(queries["funnel.cohorts"], {
				args: undefined,
				select: COHORTS_SELECT,
			}).pipe(modProvisions, Effect.provide(Layer.mergeAll(flagsStub(true), funnelWithCohorts())));
			assert.deepStrictEqual(report, {
				__typename: "FunnelCohorts",
				id: "cohorts",
				enabled: true,
				foundingPromotionsUnmeasurable: 2,
				vouchEvidenceUnmeasurable: 1,
			});
			const weeks = yield* resolveWire(lists["funnel.cohortWeeks"], {
				args: {},
				select: WEEK_SELECT,
			}).pipe(modProvisions, Effect.provide(Layer.mergeAll(flagsStub(true), funnelWithCohorts())));
			assert.strictEqual(weeks.items.length, 1);
			assert.deepStrictEqual(weeks.items[0]?.node, {
				__typename: "FunnelCohortWeek",
				id: "2026-08-03",
				signedUp: 2,
				returnedDays2to7: 0,
				firstContributed7d: 1,
				vouched7d: 1,
				promoted7d: 0,
				d1Returned: 1,
				d7Returned: 1,
				d1ReturnRate: 0.5,
				d7ReturnRate: 0.5,
			});
			const rollups = yield* resolveWire(lists["funnel.cohortRollups"], {
				args: {},
				select: WEEK_SELECT,
			}).pipe(modProvisions, Effect.provide(Layer.mergeAll(flagsStub(true), funnelWithCohorts())));
			assert.deepStrictEqual(rollups.items[0]?.node, {
				__typename: "FunnelCohortWeek",
				id: "2026-07-27",
				signedUp: 4,
				returnedDays2to7: 2,
				firstContributed7d: 1,
				vouched7d: 1,
				promoted7d: 1,
				d1Returned: 2,
				d7Returned: 3,
				d1ReturnRate: 0.5,
				d7ReturnRate: 0.75,
			});
		}),
	);
});
