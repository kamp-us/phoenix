/**
 * The sözlük stamp-wave collapse (#2709, epic #2567) — behavior equivalence + the
 * concurrency plumbing, over the substituted-`Drizzle`/service seams (ADR 0082 litmus:
 * wrong-or-right with no SQL engine → unit).
 *
 * Two properties the acceptance criteria name:
 *
 *   - **byte-for-byte equivalence.** `getDefinitionsByIds` / `listDefinitionsKeyset`
 *     produce the identical stamped rows whether the wave runs serial (flag off) or
 *     concurrent (flag on) — `myVote`, `reactions`, live author identity all unchanged.
 *     The flag flips wall time and nothing else.
 *   - **the concurrency actually threads through.** With `parallelStamps: true` the
 *     reaction aggregate's own two D1 reads receive `{concurrency: "unbounded"}` (so the
 *     wave is one phase, not one-plus-the-reaction-arm's-two); with it off/absent they
 *     receive `{concurrency: 1}` — today's serial behavior every non-opted caller keeps.
 *
 * The stamps' batched reads are substituted by recording doubles (the feature's
 * scripted-double idiom) — real read fidelity lives on the per-stamp + integration tiers.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import type {Concurrency} from "effect/Types";
import {Drizzle, type DrizzleAccess, type DrizzleDb} from "../../db/Drizzle.ts";
import type {ReactionEmoji} from "../../db/reaction-emoji.ts";
import {makePasaportStub} from "../pasaport/Pasaport.testing.ts";
import {Reaction, type ReactionAggregate} from "../reaction/Reaction.ts";
import {Vote} from "../vote/Vote.ts";
import {Sozluk, SozlukLive} from "./Sozluk.ts";

// A `definition_record` shaped just enough for `toDefinitionRow` + `ownSandboxed`.
const defRecord = (id: string, authorId: string) => ({
	id,
	body: `body of ${id}`,
	bodyExcerpt: null,
	score: 3,
	author: null,
	authorId,
	authorName: `snapshot-${authorId}`,
	termSlug: "a-term",
	termTitle: "A Term",
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	updatedAt: new Date("2026-01-02T00:00:00.000Z"),
	removedAt: null,
	removedBy: null,
	removedReason: null,
	sandboxedAt: null,
});

// Vote double: viewer holds an upvote on `d1` only → `d1.myVote === true`, `d2 === false`.
// biome-ignore lint/plugin: a service double — only `readMine` is on the read path.
const VoteStub = Layer.succeed(Vote, {
	cast: () => Effect.die(new Error("read path must not cast")),
	readMine: () => Effect.succeed(new Set<string>(["d1"])),
	clearTarget: () => Effect.void,
} as unknown as typeof Vote.Service);

const agg = (myReaction: ReactionAggregate["myReaction"]): ReactionAggregate => ({
	counts: [{emoji: "👍", count: 2}],
	myReaction,
});

// Reaction double that RECORDS the `options` (the concurrency knob) each `readAggregate`
// call received, and answers a fixed aggregate for `d1`.
const reactionRecorder = (calls: Array<{readonly concurrency?: Concurrency} | undefined>) =>
	Layer.succeed(Reaction, {
		react: () => Effect.die(new Error("read path must not react")),
		readMine: () => Effect.succeed(new Map<string, ReactionEmoji>()),
		clearTarget: () => Effect.void,
		readAggregate: (_viewerId, _kind, _ids, options) => {
			calls.push(options);
			return Effect.succeed(new Map<string, ReactionAggregate>([["d1", agg("👍")]]));
		},
	} satisfies typeof Reaction.Service);

// Pasaport double: `d1`'s author has a live handle, `d2`'s has none (→ null identity).
const PasaportStub = makePasaportStub({
	getProfileIdentitiesByIds: () =>
		Effect.succeed([{userId: "u1", username: "anka", displayName: "Anka Kadın", totalKarma: 0}]),
});

const sozlukLayer = (
	access: DrizzleAccess,
	calls: Array<{readonly concurrency?: Concurrency} | undefined>,
) =>
	SozlukLive.pipe(
		Layer.provide(VoteStub),
		Layer.provide(reactionRecorder(calls)),
		Layer.provide(PasaportStub),
		Layer.provide(Layer.succeed(Drizzle, access)),
	);

// Replays `run` results in call order (the connection test's `scriptedAccess` shape);
// `results` is `unknown`, so each answer is a single `as A` — no `as unknown as` cast.
const scriptedAccess = (results: ReadonlyArray<unknown>): DrizzleAccess => {
	let i = 0;
	return {
		run: <A>(_fn: (db: DrizzleDb) => Promise<A>) => Effect.succeed(results[i++] as A),
		batch: () => Effect.die(new Error("read path must not batch")),
	};
};

// `getDefinitionsByIds` issues exactly one `run` (the fetch); answer it with two records.
const byIdAccess = (): DrizzleAccess =>
	scriptedAccess([[defRecord("d1", "u1"), defRecord("d2", "u2")]]);

describe("Sozluk.getDefinitionsByIds — stamp-wave behavior equivalence (#2709)", () => {
	it.effect("stamped output is byte-for-byte identical with the wave serial vs concurrent", () => {
		const serialCalls: Array<{readonly concurrency?: Concurrency} | undefined> = [];
		const parallelCalls: Array<{readonly concurrency?: Concurrency} | undefined> = [];
		return Effect.gen(function* () {
			const serial = yield* Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.getDefinitionsByIds(["d1", "d2"], {
					viewerId: "viewer-1",
					parallelStamps: false,
				});
			}).pipe(Effect.provide(sozlukLayer(byIdAccess(), serialCalls)));

			const parallel = yield* Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.getDefinitionsByIds(["d1", "d2"], {
					viewerId: "viewer-1",
					parallelStamps: true,
				});
			}).pipe(Effect.provide(sozlukLayer(byIdAccess(), parallelCalls)));

			assert.deepStrictEqual(parallel, serial, "identical stamped rows");
			assert.deepStrictEqual(
				parallel.map((r) => JSON.stringify(r)),
				serial.map((r) => JSON.stringify(r)),
				"identical serialized bytes (fields, values, key order)",
			);
			// Spot the stamps actually landed (not a vacuous equality of two empty pages).
			assert.strictEqual(parallel[0]?.myVote, true, "d1 viewer upvote stamped");
			assert.strictEqual(parallel[1]?.myVote, false, "d2 no viewer upvote");
			assert.deepStrictEqual(parallel[0]?.reactions, agg("👍"), "d1 reaction aggregate stamped");
			assert.strictEqual(parallel[0]?.authorUsername, "anka", "d1 live identity stamped");
			assert.strictEqual(parallel[1]?.authorUsername, null, "d2 has no live identity");
		});
	});

	it.effect("the flag threads concurrency into the reaction aggregate's own two reads", () => {
		const onCalls: Array<{readonly concurrency?: Concurrency} | undefined> = [];
		const offCalls: Array<{readonly concurrency?: Concurrency} | undefined> = [];
		return Effect.gen(function* () {
			yield* Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				yield* sozluk.getDefinitionsByIds(["d1"], {viewerId: "v", parallelStamps: true});
			}).pipe(Effect.provide(sozlukLayer(byIdAccess(), onCalls)));
			yield* Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				yield* sozluk.getDefinitionsByIds(["d1"], {viewerId: "v", parallelStamps: false});
			}).pipe(Effect.provide(sozlukLayer(byIdAccess(), offCalls)));
			yield* Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				// No `parallelStamps` → the default-off path (today's behavior).
				yield* sozluk.getDefinitionsByIds(["d1"], {viewerId: "v"});
			}).pipe(Effect.provide(sozlukLayer(byIdAccess(), offCalls)));

			assert.deepStrictEqual(onCalls, [{concurrency: "unbounded"}], "flag on → unbounded");
			assert.deepStrictEqual(
				offCalls,
				[{concurrency: 1}, {concurrency: 1}],
				"flag off AND absent → sequential (concurrency 1)",
			);
		});
	});
});

// `listDefinitionsKeyset` (no cursor) issues: totalCount → fetch. Script both in order.
const keysetAccess = (): DrizzleAccess =>
	scriptedAccess([2 /* count */, [defRecord("d1", "u1"), defRecord("d2", "u2")] /* fetch */]);

describe("Sozluk.listDefinitionsKeyset — stamp-wave behavior equivalence (#2709)", () => {
	it.effect(
		"the connection page is byte-for-byte identical with the wave serial vs concurrent",
		() => {
			const serialCalls: Array<{readonly concurrency?: Concurrency} | undefined> = [];
			const parallelCalls: Array<{readonly concurrency?: Concurrency} | undefined> = [];
			return Effect.gen(function* () {
				const serial = yield* Effect.gen(function* () {
					const sozluk = yield* Sozluk;
					return yield* sozluk.listDefinitionsKeyset("a-term", {
						first: 10,
						viewerId: "viewer-1",
						parallelStamps: false,
					});
				}).pipe(Effect.provide(sozlukLayer(keysetAccess(), serialCalls)));

				const parallel = yield* Effect.gen(function* () {
					const sozluk = yield* Sozluk;
					return yield* sozluk.listDefinitionsKeyset("a-term", {
						first: 10,
						viewerId: "viewer-1",
						parallelStamps: true,
					});
				}).pipe(Effect.provide(sozlukLayer(keysetAccess(), parallelCalls)));

				assert.deepStrictEqual(parallel, serial, "identical connection page");
				assert.strictEqual(JSON.stringify(parallel), JSON.stringify(serial), "identical bytes");
				assert.strictEqual(parallel.rows[0]?.myVote, true, "stamps landed on the page");
				assert.deepStrictEqual(parallelCalls, [{concurrency: "unbounded"}], "flag on → unbounded");
				assert.deepStrictEqual(serialCalls, [{concurrency: 1}], "flag off → sequential");
			});
		},
	);
});
