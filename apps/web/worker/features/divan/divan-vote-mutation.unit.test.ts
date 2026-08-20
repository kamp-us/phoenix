/**
 * `divan.vote` WIRE-boundary coverage — the eligibility decision driven through
 * `resolveWire`, so a denial's wire `code` is what a client actually gets. Neighbours:
 * the yazar/mod disjunction is `gate.unit.test.ts`, the score+karma batch is
 * `vote/Vote.unit.test.ts`, the tandem invariant is `tandem.unit.test.ts`.
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
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Cause, Effect, Exit, Layer} from "effect";
import {makeNotificationStub} from "../bildirim/Notification.testing.ts";
import type {NotificationAggregateInput} from "../bildirim/Notification.ts";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {Flags} from "../flagship/Flags.ts";
import {Kunye} from "../kunye/Kunye.ts";
import type {Tier} from "../kunye/standing.ts";
import {makeVouchLedgerStub} from "../kunye/VouchLedger.testing.ts";
import type {VouchLedger} from "../kunye/VouchLedger.ts";
import {Mute} from "../mute/Mute.ts";
import {makePasaportStub} from "../pasaport/Pasaport.testing.ts";
import type {Pasaport} from "../pasaport/Pasaport.ts";
import {noopLive} from "../pasaport/promote-live.testing.ts";
import {NO_SANDBOX_SWEEP} from "../pasaport/sandbox-sweep.ts";
import type {VoteInput, VoteResult} from "../vote/Vote.ts";
import {Vote} from "../vote/Vote.ts";
import {mutations} from "./mutations.ts";

const runtimeContextStub: BaseRuntimeContext = {
	Type: "divan-vote-test",
	id: "divan-vote-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

// On, so the bildirim deliver path runs in every case.
const flagsOn: Layer.Layer<Flags> = Layer.succeed(
	Flags,
	// biome-ignore lint/plugin: a Flags test double — only getBoolean is exercised here.
	{
		getBoolean: () => Effect.succeed(true),
		getString: () => Effect.die(new Error("unused")),
		getNumber: () => Effect.die(new Error("unused")),
		getObject: () => Effect.die(new Error("unused")),
	} as unknown as typeof Flags.Service,
);

const agentAuthorityStub = Layer.succeed(AgentAuthority, {admits: () => Effect.succeed(false)});

const relationStoreOf = (holders: ReadonlyArray<string>): Layer.Layer<RelationStore> =>
	Layer.succeed(RelationStore, {
		has: (tuple) =>
			Effect.succeed(tuple.relation === "moderates" && holders.includes(tuple.subject)),
		hasSubjects: ({subjects, relation}) =>
			Effect.succeed(
				new Set(relation === "moderates" ? subjects.filter((s) => holders.includes(s)) : []),
			),
		subjectsOf: ({relation}) => Effect.succeed(new Set(relation === "moderates" ? holders : [])),
	});

const kunyeOf = (
	tierById: Record<string, Tier>,
	karmaById: Record<string, number> = {},
): Layer.Layer<Kunye> =>
	Layer.succeed(Kunye, {
		tierOf: (id: string) => Effect.succeed(tierById[id] ?? "visitor"),
		karmaOf: (id: string) => Effect.succeed(karmaById[id] ?? 0),
		rootOf: (id: string) => Effect.succeed(id),
	});

const vouchActiveFor = (active: ReadonlyArray<string>): Layer.Layer<VouchLedger> =>
	makeVouchLedgerStub({hasActiveFor: (id: string) => Effect.succeed(active.includes(id))});

// Records each promoted userId, so the tandem promotion is observable.
const pasaportRecording = (): {layer: Layer.Layer<Pasaport>; promoted: string[]} => {
	const promoted: string[] = [];
	const layer = makePasaportStub({
		promoteToYazar: ({userId}: {userId: string}) => {
			promoted.push(userId);
			return Effect.succeed({promoted: true, sweep: NO_SANDBOX_SWEEP});
		},
		getUsersByIds: () =>
			Effect.succeed([
				{
					id: "u-author",
					email: "u-author@kamp.us",
					name: "u-author",
					image: null,
					username: "u-author",
					tier: "yazar" as const,
				},
			]),
	});
	return {layer, promoted};
};

// The recorded `userId` proves WHO voted and that the gate passed before any write.
const voteStubOf = (casts: VoteInput[], authorId = "u-author"): Layer.Layer<Vote> =>
	Layer.succeed(Vote, {
		cast: () => Effect.die(new Error("divan.vote must use castOnSandboxed, not cast")),
		castOnSandboxed: (input: VoteInput) => {
			casts.push(input);
			return Effect.succeed({
				targetKind: input.targetKind,
				targetId: input.targetId,
				authorId,
				score: 1,
				myVote: input.value,
				changed: true,
			} satisfies VoteResult);
		},
		readMine: () => Effect.die(new Error("unused")),
		clearTarget: () => Effect.die(new Error("unused")),
	});

const notificationRecording = (): {
	layer: ReturnType<typeof makeNotificationStub>;
	emits: NotificationAggregateInput[];
} => {
	const emits: NotificationAggregateInput[] = [];
	const layer = makeNotificationStub({
		recordAggregate: (input) => {
			emits.push(input);
			return Effect.succeed({aggregated: false});
		},
	});
	return {layer, emits};
};

// Dies if any cast is attempted, which is how a denied path proves it never wrote.
const voteFailOnContact: Layer.Layer<Vote> = Layer.succeed(Vote, {
	cast: () => Effect.die(new Error("no cast on a denied path")),
	castOnSandboxed: () => Effect.die(new Error("a non-divan actor must never reach the cast")),
	readMine: () => Effect.die(new Error("unused")),
	clearTarget: () => Effect.die(new Error("unused")),
});

// No member is muted, so these cases exercise the deliver path. Muted-suppression is
// covered in bildirim/mute-suppression.unit.test.ts.
const noMutes = Layer.succeed(Mute, {
	set: () => Effect.die("Mute.set not exercised"),
	listMine: () => Effect.die("Mute.listMine not exercised"),
	readMutedIds: () => Effect.succeed(new Set<string>()),
});

const requestContext = (actor: Actor) =>
	Layer.mergeAll(flagsOn, noopLive, noMutes).pipe(
		Layer.provideMerge(Layer.succeed(CurrentUser, {user: {id: actorId(actor)} as never})),
		Layer.provideMerge(Layer.succeed(CurrentActor, {actor})),
		Layer.provideMerge(Layer.succeed(RuntimeContext, runtimeContextStub)),
	);

function actorId(actor: Actor): string {
	return actor._tag === "Authenticated" && actor.principal._tag === "Human"
		? actor.principal.id
		: "";
}

const castVote = (id: string, value: boolean) =>
	resolveWire(mutations["divan.vote"], {
		input: {id, value},
		select: ["id", "score", "myVote"],
	});

const wireCodeOf = (cause: Cause.Cause<unknown>): unknown => {
	const error = Cause.findErrorOption(cause);
	return error._tag === "Some" ? (error.value as {code?: unknown}).code : undefined;
};

describe("divan.vote — gated sandboxed vote", () => {
	it.effect("a yazar votes a sandboxed item; the cast credits the author (#1288)", () => {
		const casts: VoteInput[] = [];
		return Effect.gen(function* () {
			const receipt = yield* castVote("definition:def-1", true);
			assert.strictEqual((receipt as {myVote: boolean}).myVote, true);
			assert.strictEqual((receipt as {score: number}).score, 1);
			assert.deepStrictEqual(casts, [
				{userId: "u-yazar", targetKind: "definition", targetId: "def-1", value: true},
			]);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					voteStubOf(casts),
					vouchActiveFor([]), // no active vouch → resolveTandem short-circuits, no promote
					makePasaportStub(),
					relationStoreOf([]),
					kunyeOf({"u-yazar": "yazar"}),
					agentAuthorityStub,
					makeNotificationStub({recordAggregate: () => Effect.succeed({aggregated: false})}),
					requestContext(human("u-yazar")),
				),
			),
		);
	});

	it.effect("a mod (not a yazar) votes a sandboxed item — the Moderate arm alone admits", () => {
		const casts: VoteInput[] = [];
		return Effect.gen(function* () {
			const receipt = yield* castVote("post:post-1", true);
			assert.strictEqual((receipt as {myVote: boolean}).myVote, true);
			assert.deepStrictEqual(casts, [
				{userId: "u-mod", targetKind: "post", targetId: "post-1", value: true},
			]);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					voteStubOf(casts),
					vouchActiveFor([]),
					makePasaportStub(),
					relationStoreOf(["u-mod"]),
					kunyeOf({"u-mod": "çaylak"}),
					agentAuthorityStub,
					makeNotificationStub({recordAggregate: () => Effect.succeed({aggregated: false})}),
					requestContext(human("u-mod")),
				),
			),
		);
	});

	it.effect(
		"a bar-crossing vote WITH an active vouch promotes the author (the tandem, #1289)",
		() => {
			const casts: VoteInput[] = [];
			const {layer: pasaport, promoted} = pasaportRecording();
			return Effect.gen(function* () {
				yield* castVote("definition:def-1", true);
				assert.deepStrictEqual(promoted, ["u-author"]);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						voteStubOf(casts, "u-author"),
						vouchActiveFor(["u-author"]),
						pasaport,
						relationStoreOf([]),
						kunyeOf({"u-yazar": "yazar"}, {"u-author": 15}), // at VOUCH_PROMOTION_KARMA_BAR
						agentAuthorityStub,
						makeNotificationStub({recordAggregate: () => Effect.succeed({aggregated: false})}),
						requestContext(human("u-yazar")),
					),
				),
			);
		},
	);

	it.effect("a bar-crossing vote with NO active vouch does NOT promote (the tandem holds)", () => {
		const casts: VoteInput[] = [];
		return Effect.gen(function* () {
			// `makePasaportStub()`'s fail-on-contact `promoteToYazar` is the assertion that no
			// tier flip happened.
			const receipt = yield* castVote("definition:def-1", true);
			assert.strictEqual((receipt as {myVote: boolean}).myVote, true);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					voteStubOf(casts, "u-author"),
					vouchActiveFor([]), // no active vouch → short-circuit before karma + promote
					makePasaportStub(),
					relationStoreOf([]),
					kunyeOf({"u-yazar": "yazar"}, {"u-author": 99}),
					agentAuthorityStub,
					makeNotificationStub({recordAggregate: () => Effect.succeed({aggregated: false})}),
					requestContext(human("u-yazar")),
				),
			),
		);
	});

	it.effect("a çaylak (not yazar, not mod) gets the invisible UNAUTHORIZED — no cast", () =>
		Effect.gen(function* () {
			const exit = yield* castVote("definition:def-1", true).pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "UNAUTHORIZED");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					voteFailOnContact,
					makeVouchLedgerStub(),
					makePasaportStub(),
					relationStoreOf([]),
					kunyeOf({"u-caylak": "çaylak"}),
					agentAuthorityStub,
					makeNotificationStub({recordAggregate: () => Effect.succeed({aggregated: false})}),
					requestContext(human("u-caylak")),
				),
			),
		),
	);

	it.effect("an anonymous actor gets UNAUTHORIZED — no cast", () =>
		Effect.gen(function* () {
			const exit = yield* castVote("definition:def-1", true).pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "UNAUTHORIZED");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					voteFailOnContact,
					makeVouchLedgerStub(),
					makePasaportStub(),
					relationStoreOf([]),
					kunyeOf({}),
					agentAuthorityStub,
					makeNotificationStub({recordAggregate: () => Effect.succeed({aggregated: false})}),
					requestContext(unauthenticated),
				),
			),
		),
	);
});

// The silent arms assert ZERO emits against the RECORDING stub, not a dying one: the
// emitter swallows failures, so absence has to be observed rather than implied.
describe("divan.vote — rite-feedback bildirim (#1695)", () => {
	const landedVoteLayers = (
		notification: ReturnType<typeof makeNotificationStub>,
		casts: VoteInput[],
		authorId: string,
	) =>
		Layer.mergeAll(
			voteStubOf(casts, authorId),
			vouchActiveFor([]),
			makePasaportStub(),
			relationStoreOf([]),
			kunyeOf({"u-yazar": "yazar"}),
			agentAuthorityStub,
			notification,
			requestContext(human("u-yazar")),
		);

	it.effect("a landed upvote emits ONE aggregate notification for the author", () => {
		const casts: VoteInput[] = [];
		const {layer, emits} = notificationRecording();
		return Effect.gen(function* () {
			yield* castVote("definition:def-1", true);
			assert.deepStrictEqual(emits, [
				{
					recipientId: "u-author",
					kind: "divan-vote",
					targetKind: "definition",
					targetId: "def-1",
					actorId: null,
				},
			]);
		}).pipe(Effect.provide(landedVoteLayers(layer, casts, "u-author")));
	});

	it.effect("a retraction (value: false) emits nothing", () => {
		const casts: VoteInput[] = [];
		const {layer, emits} = notificationRecording();
		return Effect.gen(function* () {
			yield* castVote("definition:def-1", false);
			assert.deepStrictEqual(emits, []);
		}).pipe(Effect.provide(landedVoteLayers(layer, casts, "u-author")));
	});

	it.effect("voting your own item emits nothing (self-suppression)", () => {
		const casts: VoteInput[] = [];
		const {layer, emits} = notificationRecording();
		return Effect.gen(function* () {
			yield* castVote("definition:def-1", true);
			assert.deepStrictEqual(emits, []);
		}).pipe(Effect.provide(landedVoteLayers(layer, casts, "u-yazar")));
	});

	it.effect("a DYING notification write cannot fail the committed vote (the seam AC)", () => {
		const casts: VoteInput[] = [];
		return Effect.gen(function* () {
			// `makeNotificationStub()` dies on contact; the receipt must still land.
			const receipt = yield* castVote("definition:def-1", true);
			assert.strictEqual((receipt as {myVote: boolean}).myVote, true);
		}).pipe(Effect.provide(landedVoteLayers(makeNotificationStub(), casts, "u-author")));
	});
});
