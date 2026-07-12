/**
 * `parallelStampWave` — the read-path stamp-chain collapse (#2709, epic #2567).
 * These pin the three properties the acceptance criteria name, above any SQL engine
 * (ADR 0082):
 *
 *   - the wave issues its independent stamps CONCURRENTLY when opted in, and
 *     SEQUENTIALLY by default — proven by the observed start/end interleaving, not
 *     merely by matching results (a serial wave would match results too, so a
 *     result-only test could not tell the collapse happened);
 *   - the merged row is byte-for-byte identical whichever way it runs — same fields,
 *     same values, same key order — so the flag flips wall time and nothing else;
 *   - the empty page short-circuits to an empty result while still invoking each
 *     stamp once (each reader owns its own no-op read).
 *
 * The stamps here are in-memory doubles: a real stamp's D1 read is substituted by a
 * `yieldNow`-punctuated recorder, so "did the reads overlap" is decidable with no
 * database — the real reads' fidelity lives on the per-stamp unit tests.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {parallelStampWave, type RowStamp} from "./stamp-wave.ts";

type Row = {id: string; authorId: string};

/**
 * A stamp that records `start-i` / `end-i` around a cooperative `yieldNow`, then adds
 * one disjoint field `fI`. Under `concurrency: 1` each stamp completes before the next
 * begins (`start-0, end-0, start-1, …`); under `"unbounded"` all three reach `start`
 * before any reaches `end` — the interleaving IS the concurrency proof.
 */
const recordingStamp =
	(i: number, log: string[]): RowStamp<Row> =>
	(rows) =>
		Effect.gen(function* () {
			log.push(`start-${i}`);
			yield* Effect.yieldNow;
			log.push(`end-${i}`);
			return rows.map((r) => ({...r, [`f${i}`]: i}));
		});

describe("parallelStampWave — concurrency is opt-in (the #2709 collapse knob)", () => {
	it.effect("`unbounded` runs the stamps concurrently — every start precedes every end", () => {
		const log: string[] = [];
		const rows: Row[] = [{id: "d1", authorId: "u1"}];
		return Effect.gen(function* () {
			yield* parallelStampWave(
				rows,
				[recordingStamp(0, log), recordingStamp(1, log), recordingStamp(2, log)],
				{concurrency: "unbounded"},
			);
			assert.deepStrictEqual(
				log.slice(0, 3).map((e) => e.startsWith("start-")),
				[true, true, true],
				"all three stamps START before any ends — they overlap",
			);
			assert.deepStrictEqual(
				log.slice(3).map((e) => e.startsWith("end-")),
				[true, true, true],
				"the ends only come after every start",
			);
		});
	});

	it.effect(
		"default (no options) runs the stamps SEQUENTIALLY — each ends before the next starts",
		() => {
			const log: string[] = [];
			const rows: Row[] = [{id: "d1", authorId: "u1"}];
			return Effect.gen(function* () {
				// No `{concurrency}` → the wave defaults to 1 (effect's `concurrency ?? 1`), the
				// safe default the flag-off path relies on to reproduce today's serial reads.
				yield* parallelStampWave(rows, [
					recordingStamp(0, log),
					recordingStamp(1, log),
					recordingStamp(2, log),
				]);
				assert.deepStrictEqual(log, ["start-0", "end-0", "start-1", "end-1", "start-2", "end-2"]);
			});
		},
	);

	it.effect("`concurrency: 1` is sequential too (the flag-off value)", () => {
		const log: string[] = [];
		const rows: Row[] = [{id: "d1", authorId: "u1"}];
		return Effect.gen(function* () {
			yield* parallelStampWave(
				rows,
				[recordingStamp(0, log), recordingStamp(1, log), recordingStamp(2, log)],
				{concurrency: 1},
			);
			assert.deepStrictEqual(log, ["start-0", "end-0", "start-1", "end-1", "start-2", "end-2"]);
		});
	});
});

describe("parallelStampWave — the merge is byte-for-byte identical whichever way it runs", () => {
	// Three stamps adding disjoint fields in the same chain order a real read uses
	// (myVote → reactions → identity), so the merge reproduces the serial chain's shape.
	// Left un-annotated (not `RowStamp<Row>`) so each stamp's ADDED field type is inferred
	// and flows through the combinator's merge — the exact way the real stampers do.
	const stampA = (rows: ReadonlyArray<Row>) =>
		Effect.succeed(rows.map((r) => ({...r, myVote: true})));
	const stampB = (rows: ReadonlyArray<Row>) =>
		Effect.succeed(rows.map((r) => ({...r, reactions: {counts: [], myReaction: null}})));
	const stampC = (rows: ReadonlyArray<Row>) =>
		Effect.succeed(rows.map((r) => ({...r, authorName: `@${r.authorId}`})));

	const rows: Row[] = [
		{id: "d1", authorId: "u1"},
		{id: "d2", authorId: "u2"},
	];

	it.effect("each row is base ∪ every stamp's disjoint fields", () =>
		Effect.gen(function* () {
			const out = yield* parallelStampWave(rows, [stampA, stampB, stampC], {
				concurrency: "unbounded",
			});
			assert.deepStrictEqual(out[0], {
				id: "d1",
				authorId: "u1",
				myVote: true,
				reactions: {counts: [], myReaction: null},
				authorName: "@u1",
			});
			assert.deepStrictEqual(out[1], {
				id: "d2",
				authorId: "u2",
				myVote: true,
				reactions: {counts: [], myReaction: null},
				authorName: "@u2",
			});
		}),
	);

	it.effect(
		"the concurrency knob changes NOTHING about the output — same value, same key order",
		() =>
			Effect.gen(function* () {
				const serial = yield* parallelStampWave(rows, [stampA, stampB, stampC], {concurrency: 1});
				const parallel = yield* parallelStampWave(rows, [stampA, stampB, stampC], {
					concurrency: "unbounded",
				});
				assert.deepStrictEqual(parallel, serial, "identical merged rows");
				// Byte-for-byte: JSON key order must match too (the wire is order-sensitive).
				assert.deepStrictEqual(
					parallel.map((r) => JSON.stringify(r)),
					serial.map((r) => JSON.stringify(r)),
					"identical serialized bytes, including key order",
				);
				assert.deepStrictEqual(Object.keys(parallel[0] ?? {}), [
					"id",
					"authorId",
					"myVote",
					"reactions",
					"authorName",
				]);
			}),
	);

	it.effect("an empty page → empty result, each stamp still invoked exactly once", () => {
		const calls: number[] = [];
		const counting =
			(i: number): RowStamp<Row> =>
			(rs) =>
				Effect.sync(() => {
					calls.push(i);
					return rs;
				});
		return Effect.gen(function* () {
			const out = yield* parallelStampWave([] as Row[], [counting(0), counting(1), counting(2)], {
				concurrency: "unbounded",
			});
			assert.deepStrictEqual(out, [], "no rows → no merged rows");
			assert.deepStrictEqual(
				[...calls].sort(),
				[0, 1, 2],
				"every stamp ran once on the empty page",
			);
		});
	});
});
