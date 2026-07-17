/**
 * `divan.vote` WIRE-boundary coverage (#1288, epic #1202) — the sandboxed-vote
 * eligibility decision driven through the real external interface (`resolveWire`: input
 * decode + the `encodeWireError` class→wire-code seam), so a denial's wire `code` is what a
 * client gets.
 *
 * The acceptance matrix: a yazar OR a mod (the divan audience) votes a sandboxed item and the
 * cast lands crediting the author; a çaylak / visitor / anonymous actor gets the invisible
 * `UNAUTHORIZED` and NEVER reaches the cast (the non-gated rejection — a compile-error gate,
 * not an `if`, ADR 0107). Plus the #1204 dark-ship: flag OFF ⇒ the path is inert (no gate
 * check, no cast). And the karma-side promotion trigger (#1289): a vote that crosses the bar
 * WITH an active vouch fires `resolveTandem` → the author is promoted; with no active vouch it
 * is not. The yazar/mod disjunction itself is `gate.unit.test.ts`; the score+karma batch is
 * `vote/Vote.unit.test.ts` and the integration tier; the tandem invariant is `tandem.unit.test.ts`.
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

const flagsStub = (on: boolean): Layer.Layer<Flags> =>
	Layer.succeed(
		Flags,
		// biome-ignore lint/plugin: a Flags test double — only getBoolean is exercised here.
		{
			getBoolean: () => Effect.succeed(on),
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

// `VouchLedger` answering `hasActiveFor` from a fixed set (the candidates with ≥1 active vouch).
const vouchActiveFor = (active: ReadonlyArray<string>): Layer.Layer<VouchLedger> =>
	makeVouchLedgerStub({hasActiveFor: (id: string) => Effect.succeed(active.includes(id))});

// A `Pasaport` whose `promoteToYazar` RECORDS each promoted userId (every other method fails on
// contact), so "a vote crossed the bar with an active vouch → the çaylak is promoted" is observable.
const pasaportRecording = (): {layer: Layer.Layer<Pasaport>; promoted: string[]} => {
	const promoted: string[] = [];
	const layer = makePasaportStub({
		promoteToYazar: ({userId}: {userId: string}) => {
			promoted.push(userId);
			return Effect.succeed({promoted: true});
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

// A `Vote` whose `castOnSandboxed` RECORDS each cast and returns a receipt naming the (server-
// derived) `authorId` it credited; every other method fails on contact. The recorded `userId`
// proves WHO voted and that the gate passed before any write.
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

// A `Notification` whose `recordAggregate` RECORDS each emit (every other method fails on
// contact), so "a landed divan vote notifies the item's author, aggregated" is observable (#1695).
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

// A Vote that DIES if any cast is attempted — proves a denied path never reaches the write.
const voteFailOnContact: Layer.Layer<Vote> = Layer.succeed(Vote, {
	cast: () => Effect.die(new Error("no cast on a denied path")),
	castOnSandboxed: () => Effect.die(new Error("a non-divan actor must never reach the cast")),
	readMine: () => Effect.die(new Error("unused")),
	clearTarget: () => Effect.die(new Error("unused")),
});

// `divan.vote` fires `resolveTandem`, which reaches the #1886 live-publish on a
// landed flip — so `LivePublisher` is a static requirement of every case (even a
// denial). `noopLive` satisfies it universally; the case that actually promotes
// asserts on nothing published, and the tandem-promote case builds its own record.
// The divan-vote emit now consults `bildirimMutedBy` (#3238), which reads `Mute` — an
// empty-set stub means no member is muted, so these cases exercise the deliver path
// unchanged. Muted-suppression is covered in bildirim/mute-suppression.unit.test.ts.
const noMutes = Layer.succeed(Mute, {
	set: () => Effect.die("Mute.set not exercised"),
	listMine: () => Effect.die("Mute.listMine not exercised"),
	readMutedIds: () => Effect.succeed(new Set<string>()),
});

const requestContext = (actor: Actor, on: boolean) =>
	Layer.mergeAll(flagsStub(on), noopLive, noMutes).pipe(
		Layer.provideMerge(Layer.succeed(CurrentUser, {user: {id: actorId(actor)} as never})),
		Layer.provideMerge(Layer.succeed(CurrentActor, {actor})),
		Layer.provideMerge(Layer.succeed(RuntimeContext, runtimeContextStub)),
	);

// The signed-in id the voter casts under (anonymous → empty, never reaches the cast anyway).
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
					requestContext(human("u-yazar"), true),
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
					requestContext(human("u-mod"), true),
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
				// the vote credited "u-author" (server-derived); with an active vouch + karma ≥ bar the
				// tandem fires and flips the çaylak → yazar.
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
						requestContext(human("u-yazar"), true),
					),
				),
			);
		},
	);

	it.effect("a bar-crossing vote with NO active vouch does NOT promote (the tandem holds)", () => {
		const casts: VoteInput[] = [];
		return Effect.gen(function* () {
			// the vote lands and credits the author, but with no active vouch the tandem never flips a
			// tier — `Pasaport.promoteToYazar` fail-on-contact proves it is never reached.
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
					requestContext(human("u-yazar"), true),
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
					requestContext(human("u-caylak"), true),
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
					requestContext(unauthenticated, true),
				),
			),
		),
	);

	it.effect("with the #1204 flag OFF the path is inert — no gate check, no cast", () =>
		Effect.gen(function* () {
			const receipt = yield* castVote("definition:def-1", true);
			assert.strictEqual((receipt as {myVote: boolean}).myVote, false);
			assert.strictEqual((receipt as {score: number}).score, 0);
		}).pipe(
			// The cast, the gate's authority seam, and the promote seam all fail-on-contact: none reached.
			Effect.provide(
				Layer.mergeAll(
					voteFailOnContact,
					makeVouchLedgerStub(),
					makePasaportStub(),
					Layer.succeed(RelationStore, {
						has: () => Effect.die(new Error("flag OFF must not check authority")),
						hasSubjects: () => Effect.die(new Error("flag OFF must not check authority")),
						subjectsOf: () => Effect.die(new Error("flag OFF must not check authority")),
					}),
					kunyeOf({"u-yazar": "yazar"}),
					agentAuthorityStub,
					makeNotificationStub({recordAggregate: () => Effect.succeed({aggregated: false})}),
					requestContext(human("u-yazar"), false),
				),
			),
		),
	);
});

// Rite feedback (#1695): a landed divan vote notifies the item's author through the
// bildirim spine — aggregated per item, self-suppressed, and NEVER able to fail the
// committed cast. The retraction/self arms use the recording stub and assert ZERO
// emits (the swallow would hide a die, so absence must be observed, not implied).
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
			requestContext(human("u-yazar"), true),
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
			// the cast credits the VOTER as author → no self-notification
			yield* castVote("definition:def-1", true);
			assert.deepStrictEqual(emits, []);
		}).pipe(Effect.provide(landedVoteLayers(layer, casts, "u-yazar")));
	});

	it.effect("a DYING notification write cannot fail the committed vote (the seam AC)", () => {
		const casts: VoteInput[] = [];
		return Effect.gen(function* () {
			// fail-on-contact Notification: recordAggregate DIES; the receipt still lands.
			const receipt = yield* castVote("definition:def-1", true);
			assert.strictEqual((receipt as {myVote: boolean}).myVote, true);
		}).pipe(Effect.provide(landedVoteLayers(makeNotificationStub(), casts, "u-author")));
	});
});
