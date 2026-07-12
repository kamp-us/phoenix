/**
 * The keyset-chunk decay sweep (`scanDecayChunks`, #2559), unit-reachable over in-memory
 * ports — the cursor-advance + full-coverage control flow is wrong-or-right with no SQL
 * engine (ADR 0082 litmus), so it is driven here over a JS-array table, never real D1. The
 * pure decay math (`decayHotScores`) has its own unit test; the real-D1 chunk EXECUTION
 * (the paged walk over `post_record`) stays integration-tier (`pano-hot-score-decay.test.ts`).
 *
 * The two properties this guards, both the point of #2559:
 *   - WINDOWLESS coverage (#2133 preserved): the sweep visits EVERY row across its pages, so
 *     a post beyond the first chunk is still decayed — chunking is not a recency window.
 *   - BOUNDED pages: each `fetchChunk` asks for at most `chunkSize` rows and resumes at a
 *     cursor strictly past the previous page's last id — no single unbounded scan.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import type {HotDecayRow, HotDecayUpdate} from "../../db/hotScoreDecay.ts";
import {type HotDecayScanPorts, scanDecayChunks} from "./post-operations.ts";

/** A row that decays: `score 0` recomputes to `hot_score 0`, so a stored `5` always changes. */
const changing = (id: string): HotDecayRow => ({id, score: 0, hotScore: 5, createdAtMs: 0});
/** A row at rest: stored `hot_score 0` already equals the recompute, so it never writes. */
const steady = (id: string): HotDecayRow => ({id, score: 0, hotScore: 0, createdAtMs: 0});

interface Harness {
	readonly ports: HotDecayScanPorts;
	/** Every `fetchChunk(afterId, limit)` call, in order — the paging trace. */
	readonly fetchCalls: Array<{afterId: string | null; limit: number}>;
	/** Every id passed to `writeBack`, across all pages — the coverage trace. */
	readonly written: string[];
	/** How many times `writeBack` was invoked (a no-change page issues none). */
	readonly writeBackCalls: {count: number};
}

/**
 * In-memory ports over a fixed, id-sorted table: `fetchChunk` serves the keyset page
 * (`id > afterId`, capped at `limit`) and records the cursor + limit it was asked for;
 * `writeBack` records every rewritten id. This is the exact contract `makeRefreshHotScores`
 * wires D1 into — so the driver's paging behavior is proven without a database.
 */
function harness(table: ReadonlyArray<HotDecayRow>): Harness {
	const sorted = [...table].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const fetchCalls: Array<{afterId: string | null; limit: number}> = [];
	const written: string[] = [];
	const writeBackCalls = {count: 0};
	const ports: HotDecayScanPorts = {
		fetchChunk: (afterId, limit) =>
			Effect.sync(() => {
				fetchCalls.push({afterId, limit});
				return sorted.filter((r) => afterId === null || r.id > afterId).slice(0, limit);
			}),
		writeBack: (updates: ReadonlyArray<HotDecayUpdate>) =>
			Effect.sync(() => {
				writeBackCalls.count++;
				for (const u of updates) written.push(u.id);
			}),
	};
	return {ports, fetchCalls, written, writeBackCalls};
}

describe("scanDecayChunks — keyset-chunks the windowless sweep (#2559)", () => {
	it.effect("a table larger than the chunk size is fully covered — every post is decayed", () =>
		Effect.gen(function* () {
			const h = harness(["p1", "p2", "p3", "p4", "p5"].map(changing));
			const result = yield* scanDecayChunks(h.ports, Date.now(), 2);

			assert.strictEqual(result.scanned, 5, "every live row is scanned across the pages");
			assert.strictEqual(result.updated, 5, "every changed row is written back");
			// Windowless: a post in the THIRD page (p5) is decayed just like p1 — no recency cutoff.
			assert.deepStrictEqual(
				[...h.written].sort(),
				["p1", "p2", "p3", "p4", "p5"],
				"the sweep covers the whole table, not just the first chunk",
			);
		}),
	);

	it.effect("pages are bounded and the cursor advances strictly past each page's last id", () =>
		Effect.gen(function* () {
			const h = harness(["p1", "p2", "p3", "p4", "p5"].map(changing));
			yield* scanDecayChunks(h.ports, Date.now(), 2);

			// Pages of [p1,p2],[p3,p4],[p5] — the short third page (1 < 2) marks the tail, so no
			// fourth fetch. Each call asks for at most `chunkSize`, resuming at the prior last id.
			assert.deepStrictEqual(
				h.fetchCalls,
				[
					{afterId: null, limit: 2},
					{afterId: "p2", limit: 2},
					{afterId: "p4", limit: 2},
				],
				"cursor walks null → p2 → p4, limit stays chunkSize, short page terminates",
			);
		}),
	);

	it.effect("an exact-multiple table takes one extra empty page to terminate", () =>
		Effect.gen(function* () {
			const h = harness(["p1", "p2", "p3", "p4"].map(changing));
			const result = yield* scanDecayChunks(h.ports, Date.now(), 2);

			assert.strictEqual(result.scanned, 4, "all four rows scanned");
			// Pages [p1,p2],[p3,p4] are both full, so the loop cannot know it is done until an
			// empty page after p4 — three fetches, the last returning zero rows.
			assert.deepStrictEqual(
				h.fetchCalls,
				[
					{afterId: null, limit: 2},
					{afterId: "p2", limit: 2},
					{afterId: "p4", limit: 2},
				],
				"a full final page forces one terminating empty fetch",
			);
		}),
	);

	it.effect("steady state — no changed rows means no writeBack call (no churn)", () =>
		Effect.gen(function* () {
			const h = harness(["p1", "p2", "p3"].map(steady));
			const result = yield* scanDecayChunks(h.ports, Date.now(), 2);

			assert.strictEqual(result.scanned, 3, "every row is still scanned");
			assert.strictEqual(result.updated, 0, "nothing decayed to a new value");
			assert.strictEqual(h.writeBackCalls.count, 0, "an unchanged page issues no write");
		}),
	);

	it.effect("an empty table scans nothing and writes nothing in a single head fetch", () =>
		Effect.gen(function* () {
			const h = harness([]);
			const result = yield* scanDecayChunks(h.ports, Date.now(), 2);

			assert.deepStrictEqual(result, {scanned: 0, updated: 0});
			assert.deepStrictEqual(h.fetchCalls, [{afterId: null, limit: 2}], "one empty head fetch");
			assert.strictEqual(h.writeBackCalls.count, 0);
		}),
	);
});
