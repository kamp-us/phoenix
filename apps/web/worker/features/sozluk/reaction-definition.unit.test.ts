/**
 * `Sozluk.reactToDefinition` service-seam coverage (epic #1840, #1865) — the
 * cross-product wiring that proves the one reaction template spans sözlük. Driven
 * over a substituted `Drizzle` (the definition load) + a RECORDING `Reaction` double
 * + a fail-on-contact `Vote`, so three things are wrong-or-right with no SQL engine:
 *
 *   - **cast / change / retract on the definition path.** The reactor's intent
 *     (`👍` set, `❤️` change, `null` retract) is delegated verbatim to
 *     `Reaction.react` as `{userId, targetKind: "definition", targetId, emoji}`, and
 *     the re-resolved row carries the FRESH aggregate the engine returned. The
 *     cardinality-one write itself is `Reaction.unit.test.ts`; this pins the
 *     definition-path DELEGATION + re-hydration.
 *   - **ungated + karma-free.** `Vote.cast` fail-on-contact: a passing test proves the
 *     react path never casts a vote or writes karma (the settled #1861 divergence).
 *   - **target-miss → `DefinitionNotFound`.** A missing/removed definition is this
 *     surface's not-found, never the engine's `ReactionTargetNotFound`.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit, Layer} from "effect";
import {Drizzle, type DrizzleAccess} from "../../db/Drizzle.ts";
import type {ReactionEmoji} from "../../db/reaction-emoji.ts";
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

const DEF_ID = "def-1";
const REACTOR = "u-reactor";

// The scripted `definition_record` the up-front load returns (or `undefined` for the
// not-found path). The reads only touch `toDefinitionRow`'s columns; the rest satisfy
// the row shape without being exercised.
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

// One `run` (the definition load) is the only DB touch; a direct `batch` would mean
// the react path wrote SQL itself instead of delegating to the engine — die on it.
const definitionAccess = (row: unknown): DrizzleAccess => ({
	run: () => Effect.succeed(row as never),
	batch: () =>
		Effect.die(
			new Error("reactToDefinition writes through the Reaction engine, never a direct batch"),
		),
});

// A `Vote` that DIES on any cast — proves the react path is karma-free / ungated
// (`readMine` alone is on the `myVote` stamp path and returns empty, no DB read).
// biome-ignore lint/plugin: a service double — only `readMine` is reached; `cast` fail-on-contact is the karma-free proof.
const VoteStub = Layer.succeed(Vote, {
	cast: () =>
		Effect.die(new Error("reactToDefinition must never cast a vote (ungated, karma-free)")),
	readMine: () => Effect.succeed(new Set<string>()),
	clearTarget: () => Effect.void,
} as unknown as typeof Vote.Service);

// A `Reaction` that RECORDS every `react` input and replays a scripted aggregate on
// `readAggregate` — so the delegated `{targetKind, targetId, emoji}` and the
// re-hydrated aggregate are both observable with no engine/DB.
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
				// The intent is delegated verbatim to the ungated, karma-free engine.
				assert.deepStrictEqual(reactCalls, [
					{userId: REACTOR, targetKind: "definition", targetId: DEF_ID, emoji},
				]);
				// The re-resolved row carries the FRESH aggregate the engine returned.
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

	// Retract: the target drops out of the aggregate map, so the stamp fills the empty
	// aggregate — no counts, no viewer reaction.
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
