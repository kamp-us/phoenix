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
 * check, no cast). The yazar/mod disjunction itself is `gate.unit.test.ts`; the score+karma
 * batch is `vote/Vote.unit.test.ts` and the integration tier.
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
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {Flags} from "../flagship/Flags.ts";
import {Kunye} from "../kunye/Kunye.ts";
import type {Tier} from "../kunye/standing.ts";
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
	});

const kunyeOf = (tierById: Record<string, Tier>): Layer.Layer<Kunye> =>
	Layer.succeed(Kunye, {
		tierOf: (id: string) => Effect.succeed(tierById[id] ?? "visitor"),
		karmaOf: () => Effect.die(new Error("divan vote must not read karma")),
		rootOf: (id: string) => Effect.succeed(id),
	});

// A `Vote` whose `castOnSandboxed` RECORDS each cast and returns a fixed receipt; every other
// method fails on contact (the divan vote uses only `castOnSandboxed`). The recorded `userId`
// proves WHO is credited and that the gate passed before any write.
const voteStubOf = (casts: VoteInput[]): Layer.Layer<Vote> =>
	Layer.succeed(Vote, {
		cast: () => Effect.die(new Error("divan.vote must use castOnSandboxed, not cast")),
		castOnSandboxed: (input: VoteInput) => {
			casts.push(input);
			return Effect.succeed({
				targetKind: input.targetKind,
				targetId: input.targetId,
				score: 1,
				myVote: input.value,
				changed: true,
			} satisfies VoteResult);
		},
		readMine: () => Effect.die(new Error("unused")),
		clearTarget: () => Effect.die(new Error("unused")),
	});

// A Vote that DIES if any cast is attempted — proves a denied path never reaches the write.
const voteFailOnContact: Layer.Layer<Vote> = Layer.succeed(Vote, {
	cast: () => Effect.die(new Error("no cast on a denied path")),
	castOnSandboxed: () => Effect.die(new Error("a non-divan actor must never reach the cast")),
	readMine: () => Effect.die(new Error("unused")),
	clearTarget: () => Effect.die(new Error("unused")),
});

const requestContext = (actor: Actor, on: boolean) =>
	Layer.mergeAll(flagsStub(on)).pipe(
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
					relationStoreOf([]),
					kunyeOf({"u-yazar": "yazar"}),
					agentAuthorityStub,
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
					relationStoreOf(["u-mod"]),
					kunyeOf({"u-mod": "çaylak"}),
					agentAuthorityStub,
					requestContext(human("u-mod"), true),
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
					relationStoreOf([]),
					kunyeOf({"u-caylak": "çaylak"}),
					agentAuthorityStub,
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
					relationStoreOf([]),
					kunyeOf({}),
					agentAuthorityStub,
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
			// Both the cast seam and the gate's authority seam fail-on-contact: neither is reached.
			Effect.provide(
				Layer.mergeAll(
					voteFailOnContact,
					Layer.succeed(RelationStore, {
						has: () => Effect.die(new Error("flag OFF must not check authority")),
					}),
					kunyeOf({"u-yazar": "yazar"}),
					agentAuthorityStub,
					requestContext(human("u-yazar"), false),
				),
			),
		),
	);
});
