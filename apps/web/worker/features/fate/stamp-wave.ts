/**
 * `parallelStampWave` — collapse a read's serial stamp chain into one concurrent
 * wave. A finalized read (`Definition`, `Comment`) is stamped with several
 * independent facets — viewer scalars (`stampViewerScalars`), the reaction
 * aggregate (`stampReactionAggregate`), live author identity (`stampAuthorIdentity`).
 * Each is independent GIVEN the already-fetched rows: it reads only the base row's
 * `id` / `authorId` and ADDS a disjoint field set, never another stamp's output.
 * Chaining them with `yield*` therefore pays N cross-region D1 round trips strictly
 * in sequence for no ordering reason (the #2567 baseline). This runs every stamp
 * over the SAME base rows and merges their added fields back index-wise.
 *
 * The `concurrency` option is the whole point, and it is NOT optional cosmetics:
 * `Effect.all` defaults to sequential execution — effect@4.0.0-beta.92's `Effect.all`
 * (an iterable delegates to `forEach`) documents "Concurrency: … By default, the
 * operations are performed sequentially" (`Effect.ts` JSDoc), backed by
 * `internal/effect.ts` `forEach` (`concurrency ?? 1` → `if (concurrency === 1)
 * return forEachSequential`). So a wave that omits `{concurrency}` changes nothing.
 * Pass `"unbounded"` to actually fan the stamps out; the default `1` reproduces
 * today's serial phase count byte-for-byte (same reads, same order, same merged
 * rows) — the safe default the sözlük containment flag flips.
 *
 * Merge correctness: every stamp returns the base rows in input order, each row
 * extended with its own disjoint fields, so `Object.assign({}, …outsAtIndex)`
 * rebuilds `base ∪ every stamp's fields` with the same key order the serial chain
 * produced. Independence is the caller's contract — a stamp that READ another
 * stamp's added field would need the chain, not this wave.
 */
import {Effect} from "effect";
import type {Concurrency} from "effect/Types";

/** A row stamp: given the base page, return each row extended with its own fields. */
export type RowStamp<R> = (rows: ReadonlyArray<R>) => Effect.Effect<ReadonlyArray<R>>;

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
	x: infer I,
) => void
	? I
	: never;

type StampOutput<R, S> = S extends (rows: ReadonlyArray<R>) => Effect.Effect<ReadonlyArray<infer O>>
	? O
	: never;

export const parallelStampWave = <
	R extends {id: string},
	const Stamps extends ReadonlyArray<RowStamp<R>>,
>(
	rows: ReadonlyArray<R>,
	stamps: Stamps,
	options?: {readonly concurrency?: Concurrency},
): Effect.Effect<Array<UnionToIntersection<StampOutput<R, Stamps[number]>>>> =>
	Effect.gen(function* () {
		const stamped = yield* Effect.all(
			stamps.map((stamp) => stamp(rows)),
			{concurrency: options?.concurrency ?? 1},
		);
		return rows.map((_, i) => Object.assign({}, ...stamped.map((out) => out[i]))) as Array<
			UnionToIntersection<StampOutput<R, Stamps[number]>>
		>;
	});
