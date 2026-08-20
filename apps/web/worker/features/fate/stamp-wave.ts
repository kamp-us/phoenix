/**
 * `parallelStampWave` — run a read's independent stamps over the SAME base rows and merge
 * their added fields index-wise, instead of chaining them for N serial D1 round trips
 * (#2567).
 *
 * Independence is the CALLER's contract: a stamp that read another stamp's added field
 * would need the chain, not this wave.
 *
 * `Effect.all` defaults to sequential — effect@4.0.0-beta.92 documents "By default, the
 * operations are performed sequentially" (`Effect.ts` JSDoc), backed by
 * `internal/effect.ts` `forEach` (`concurrency ?? 1` → `forEachSequential`). So a wave
 * that omits `{concurrency}` changes nothing; the default `1` here reproduces today's
 * serial phase count byte-for-byte, and `"unbounded"` is what actually fans out.
 */
import {Effect} from "effect";
import type {Concurrency} from "effect/Types";

/** Given the base page, return each row extended with its own fields. */
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
