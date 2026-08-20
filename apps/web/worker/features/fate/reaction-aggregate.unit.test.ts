/**
 * `stampReactionAggregate` (#1862). Two properties, above any SQL engine: the
 * aggregate lands on EVERY row, and a target absent from the batch gets the EMPTY
 * aggregate rather than a hole — so the wire field is never missing.
 *
 * The real `GROUP BY` fidelity lives in `Reaction.unit.test.ts` / integration.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import type {ReactionAggregate} from "../reaction/Reaction.ts";
import {EMPTY_REACTION_AGGREGATE, type Reaction} from "../reaction/Reaction.ts";
import {stampReactionAggregate} from "./reaction-aggregate.ts";

// Answers from a fixed per-id map and records the ids it was called with.
const stubReaction = (
	answers: ReadonlyMap<string, ReactionAggregate>,
	calls: string[][],
): typeof Reaction.Service =>
	({
		react: () => Effect.die(new Error("stampReactionAggregate must not react")),
		readMine: () => Effect.die(new Error("stampReactionAggregate must not readMine")),
		clearTarget: () => Effect.die(new Error("stampReactionAggregate must not clearTarget")),
		readAggregate: (_viewerId, _kind, ids) => {
			calls.push([...ids]);
			return Effect.succeed(new Map([...answers].filter(([id]) => ids.includes(id))));
		},
	}) satisfies typeof Reaction.Service;

const agg = (counts: ReactionAggregate["counts"], myReaction: ReactionAggregate["myReaction"]) =>
	({counts, myReaction}) satisfies ReactionAggregate;

describe("stampReactionAggregate — the fate-view aggregate stamp (#1862)", () => {
	it.effect("stamps `reactions` on every row, ONE read for the whole batch", () => {
		const answers = new Map<string, ReactionAggregate>([
			["d1", agg([{emoji: "👍", count: 2}], "👍")],
			["d2", agg([{emoji: "🔥", count: 1}], null)],
		]);
		const calls: string[][] = [];
		const rows = [
			{id: "d1", score: 5},
			{id: "d2", score: 3},
		];
		return Effect.gen(function* () {
			const stamped = yield* stampReactionAggregate(
				stubReaction(answers, calls),
				"definition",
				rows,
				"viewer-1",
			);
			// One read over the whole page — never per row (the N+1-avoidance contract).
			assert.strictEqual(calls.length, 1, "exactly one batched aggregate read");
			assert.deepStrictEqual(calls[0], ["d1", "d2"], "the read covers the whole page's ids");

			assert.deepStrictEqual(stamped[0], {
				id: "d1",
				score: 5,
				reactions: agg([{emoji: "👍", count: 2}], "👍"),
			});
			assert.deepStrictEqual(stamped[1], {
				id: "d2",
				score: 3,
				reactions: agg([{emoji: "🔥", count: 1}], null),
			});
		});
	});

	it.effect("a target ABSENT from the batch gets the empty aggregate, never a hole", () => {
		const answers = new Map<string, ReactionAggregate>([
			["d1", agg([{emoji: "😂", count: 4}], null)],
		]);
		const rows = [
			{id: "d1", score: 1},
			{id: "d2", score: 2},
		];
		return Effect.gen(function* () {
			const stamped = yield* stampReactionAggregate(stubReaction(answers, []), "post", rows, null);
			assert.deepStrictEqual(stamped[1]?.reactions, EMPTY_REACTION_AGGREGATE);
			// The field is present on every row — the wire shape never has a missing key.
			assert.isTrue(
				stamped.every((r) => "reactions" in r),
				"reactions present on every row",
			);
		});
	});

	it.effect("empty rows → empty result, and still exactly one (empty) read", () => {
		const calls: string[][] = [];
		return Effect.gen(function* () {
			const stamped = yield* stampReactionAggregate(
				stubReaction(new Map(), calls),
				"comment",
				[],
				"viewer-1",
			);
			assert.deepStrictEqual(stamped, []);
			assert.deepStrictEqual(calls[0], [], "the read is issued with no ids");
		});
	});
});
