/**
 * `Sozluk.reactToDefinition` service-seam coverage, over a substituted `Drizzle` + a
 * RECORDING `Reaction` double + a fail-on-contact `Vote`. Pins the definition-path
 * DELEGATION and re-hydration (the cardinality-one write itself is `Reaction.unit.test.ts`),
 * that the path never casts a vote or writes karma, and that a target miss surfaces as
 * `DefinitionNotFound` rather than the engine's `ReactionTargetNotFound`.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit, Layer} from "effect";
import {Drizzle, type DrizzleAccess} from "../../db/Drizzle.ts";
import type {ReactionEmoji} from "../../db/reaction-emoji.ts";
import {DefinitionId, UserId} from "../../lib/ids.ts";
import {PasaportIdentityStub} from "../pasaport/Pasaport.testing.ts";
import {
	EMPTY_REACTION_AGGREGATE,
	type ReactInput,
	Reaction,
	type ReactionAggregate,
	type ReactResult,
} from "../reaction/Reaction.ts";
import {Vote} from "../vote/Vote.ts";
import {Sozluk, SozlukLive} from "./Sozluk.ts";

const DEF_ID = DefinitionId.make("def-1");
const REACTOR = UserId.make("u-reactor");

const definitionRow = {
	id: DEF_ID,
	body: "bir tanım",
	score: 3,
	authorName: "yazar",
	authorId: "u-author",
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
	removedAt: null,
	sandboxedAt: null,
	termSlug: "bir-terim",
	termTitle: "bir terim",
	bodyExcerpt: "bir tanım",
};

// A direct `batch` would mean the react path wrote SQL itself instead of delegating to the
// engine — die on it.
const definitionAccess = (row: unknown): DrizzleAccess => ({
	run: () => Effect.succeed(row as never),
	batch: () =>
		Effect.die(
			new Error("reactToDefinition writes through the Reaction engine, never a direct batch"),
		),
});

// Dies on any cast — proves the react path is karma-free / ungated.
// biome-ignore lint/plugin: a service double — only `readMine` is reached; `cast` fail-on-contact is the karma-free proof.
const VoteStub = Layer.succeed(Vote, {
	cast: () =>
		Effect.die(new Error("reactToDefinition must never cast a vote (ungated, karma-free)")),
	readMine: () => Effect.succeed(new Set<string>()),
	clearTarget: () => Effect.void,
} as unknown as typeof Vote.Service);

// Records every `react` input and replays a scripted aggregate on `readAggregate`, so the
// delegated input and the re-hydrated aggregate are both observable with no engine.
const recordingReaction = (
	reactCalls: ReactInput[],
	aggregateById: ReadonlyMap<string, ReactionAggregate>,
): Layer.Layer<Reaction> =>
	Layer.succeed(Reaction, {
		react: (input: ReactInput) =>
			Effect.sync(() => {
				reactCalls.push(input);
				return {
					targetKind: input.targetKind,
					targetId: input.targetId,
					myReaction: input.emoji,
					changed: true,
				} satisfies ReactResult;
			}),
		readMine: () => Effect.succeed(new Map<string, ReactionEmoji>()),
		readAggregate: () => Effect.succeed(new Map(aggregateById)),
		clearTarget: () => Effect.void,
	} satisfies typeof Reaction.Service);

const sozlukLayer = (
	row: unknown,
	reactCalls: ReactInput[],
	aggregateById: ReadonlyMap<string, ReactionAggregate>,
) =>
	SozlukLive.pipe(
		Layer.provide(VoteStub),
		Layer.provide(recordingReaction(reactCalls, aggregateById)),
		Layer.provide(PasaportIdentityStub),
		Layer.provide(Layer.succeed(Drizzle, definitionAccess(row))),
	);

describe("Sozluk.reactToDefinition — cast / change / retract delegate to the Reaction engine", () => {
	const delegationCase = (
		label: string,
		emoji: ReactionEmoji | null,
		aggregate: ReactionAggregate,
		aggregateById: ReadonlyMap<string, ReactionAggregate>,
	) =>
		it.effect(label, () => {
			const reactCalls: ReactInput[] = [];
			return Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				const row = yield* sozluk.reactToDefinition({
					definitionId: DEF_ID,
					reactorId: REACTOR,
					emoji,
				});
				assert.deepStrictEqual(reactCalls, [
					{userId: REACTOR, targetKind: "definition", targetId: DEF_ID, emoji},
				]);
				assert.strictEqual(row.id, DEF_ID);
				assert.deepStrictEqual(row.reactions, aggregate);
			}).pipe(Effect.provide(sozlukLayer(definitionRow, reactCalls, aggregateById)));
		});

	delegationCase(
		"cast: 👍 is delegated and the row carries the 1-count aggregate + myReaction 👍",
		"👍",
		{counts: [{emoji: "👍", count: 1}], myReaction: "👍"},
		new Map([[DEF_ID, {counts: [{emoji: "👍", count: 1}], myReaction: "👍"}]]),
	);

	delegationCase(
		"change: ❤️ replaces the prior reaction — the row reflects the changed emoji",
		"❤️",
		{counts: [{emoji: "❤️", count: 1}], myReaction: "❤️"},
		new Map([[DEF_ID, {counts: [{emoji: "❤️", count: 1}], myReaction: "❤️"}]]),
	);

	// Retract: the target drops out of the aggregate map, so the stamp fills the empty one.
	delegationCase(
		"retract: null is delegated and the row falls back to the empty aggregate",
		null,
		EMPTY_REACTION_AGGREGATE,
		new Map<string, ReactionAggregate>(),
	);
});

describe("Sozluk.reactToDefinition — a missing definition is DefinitionNotFound (never reaches the engine)", () => {
	it.effect("an absent target fails DefinitionNotFound and never reacts", () => {
		const reactCalls: ReactInput[] = [];
		return Effect.gen(function* () {
			const sozluk = yield* Sozluk;
			const exit = yield* sozluk
				.reactToDefinition({definitionId: DEF_ID, reactorId: REACTOR, emoji: "👍"})
				.pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) {
				const err = Exit.isFailure(exit) ? exit.cause : undefined;
				assert.match(String(err), /DefinitionNotFound/);
			}
			assert.deepStrictEqual(reactCalls, [], "a missing target never reaches the engine");
		}).pipe(Effect.provide(sozlukLayer(undefined, reactCalls, new Map())));
	});
});
