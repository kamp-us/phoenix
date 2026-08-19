/**
 * The self-vote guard (#2216), proven over the real `SozlukLive` with a substituted
 * `Drizzle` and a recording `Vote`, so no SQL engine is needed. The guard is
 * cast-only: retracting a vote on one's own definition still reaches `Vote.cast`,
 * because a blocked cast leaves nothing to retract.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit, Layer} from "effect";
import {Drizzle, type DrizzleAccess} from "../../db/Drizzle.ts";
import {DefinitionId, UserId} from "../../lib/ids.ts";
import {PasaportIdentityStub} from "../pasaport/Pasaport.testing.ts";
import {Reaction} from "../reaction/Reaction.ts";
import type {VoteInput, VoteResult} from "../vote/Vote.ts";
import {Vote} from "../vote/Vote.ts";
import {Sozluk, SozlukLive} from "./Sozluk.ts";

const AUTHOR = UserId.make("u-author");
const OTHER = UserId.make("u-other");
const DEF_ID = DefinitionId.make("def-1");

// Only `authorId` drives the guard. `changed:false` from the Vote double keeps
// `persistTermSummary` off the path, so one read is enough.
const definitionRow = {
	id: DEF_ID,
	body: "bir tanım",
	score: 3,
	authorName: "yazar",
	authorId: AUTHOR,
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
	removedAt: null,
	sandboxedAt: null,
	termSlug: "bir-terim",
	termTitle: "bir terim",
	bodyExcerpt: "bir tanım",
};

const definitionAccess = (row: unknown): DrizzleAccess => ({
	run: () => Effect.succeed(row as never),
	batch: () => Effect.die(new Error("the vote path takes no direct batch in self-vote-guard")),
});

// Records every cast, so "did the cast path run" is observable with no engine. Every
// other method dies on contact.
const recordingVote = (casts: VoteInput[]): Layer.Layer<Vote> =>
	Layer.succeed(
		Vote,
		new Proxy(
			{
				cast: (input: VoteInput) =>
					Effect.sync(() => {
						casts.push(input);
						return {
							targetKind: input.targetKind,
							targetId: input.targetId,
							authorId: AUTHOR,
							score: definitionRow.score,
							myVote: input.value,
							changed: false,
						} satisfies VoteResult;
					}),
			} as Partial<typeof Vote.Service>,
			{
				get(target, prop) {
					if (prop in target) return (target as Record<string, unknown>)[prop as string];
					return () => Effect.die(`Vote.${String(prop)} not exercised in self-vote-guard`);
				},
			},
		) as typeof Vote.Service,
	);

// The vote path never reacts, so a fail-on-contact `Reaction` proves it.
const reactionStub = Layer.succeed(
	Reaction,
	new Proxy({} as Partial<typeof Reaction.Service>, {
		get(_target, prop) {
			return () => Effect.die(`Reaction.${String(prop)} not exercised in self-vote-guard`);
		},
	}) as typeof Reaction.Service,
);

const sozlukLayer = (casts: VoteInput[]) =>
	SozlukLive.pipe(
		Layer.provide(recordingVote(casts)),
		Layer.provide(reactionStub),
		Layer.provide(PasaportIdentityStub),
		Layer.provide(Layer.succeed(Drizzle, definitionAccess(definitionRow))),
	);

describe("Sozluk.applyVote — the self-vote guard (#2216)", () => {
	it.effect("(1) a self-cast fails SelfVoteNotAllowed and never reaches Vote.cast", () => {
		const casts: VoteInput[] = [];
		return Effect.gen(function* () {
			const sozluk = yield* Sozluk;
			const exit = yield* sozluk
				.voteDefinition({definitionId: DEF_ID, voterId: AUTHOR})
				.pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit), "a self-cast is rejected");
			if (Exit.isFailure(exit)) {
				assert.match(String(exit.cause), /SelfVoteNotAllowed/);
			}
			assert.deepStrictEqual(casts, [], "Vote.cast is never reached on a self-cast");
		}).pipe(Effect.provide(sozlukLayer(casts)));
	});

	it.effect("(2) a non-author cast reaches Vote.cast and lands", () => {
		const casts: VoteInput[] = [];
		return Effect.gen(function* () {
			const sozluk = yield* Sozluk;
			const result = yield* sozluk.voteDefinition({definitionId: DEF_ID, voterId: OTHER});
			assert.deepStrictEqual(casts, [
				{userId: OTHER, targetKind: "definition", targetId: DEF_ID, value: true},
			]);
			assert.strictEqual(result.definitionId, DEF_ID);
		}).pipe(Effect.provide(sozlukLayer(casts)));
	});

	it.effect("(3) a self-RETRACT is exempt — it reaches Vote.cast (cast-only guard)", () => {
		const casts: VoteInput[] = [];
		return Effect.gen(function* () {
			const sozluk = yield* Sozluk;
			yield* sozluk.retractDefinitionVote({definitionId: DEF_ID, voterId: AUTHOR});
			assert.deepStrictEqual(casts, [
				{userId: AUTHOR, targetKind: "definition", targetId: DEF_ID, value: false},
			]);
		}).pipe(Effect.provide(sozlukLayer(casts)));
	});
});
