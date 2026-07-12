/**
 * The backstop-reconciliation keyset-chunk sweep (`scanReconcileChunks`, #2558), unit-reachable
 * over in-memory ports — the cursor-advance + full-coverage control flow is wrong-or-right with
 * no SQL engine (ADR 0082 litmus), so it is driven here over a JS-array table, never real D1.
 * The real-D1 chunk EXECUTION (the paged walk over `term_record` + the actual re-convergence of
 * a term left stale by a swallowed refresh) stays integration-tier (`sozluk-cache-reconcile.test.ts`).
 *
 * The two properties this guards, both the point of #2558's bounded full sweep:
 *   - FULL coverage: the sweep visits EVERY term across its pages, so a term beyond the first
 *     chunk is still re-refreshed — chunking is not a recency/subset window.
 *   - BOUNDED pages: each `fetchChunk` asks for at most `chunkSize` rows and resumes at a cursor
 *     strictly past the previous page's last slug — no single unbounded scan.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {type SozlukReconcileScanPorts, scanReconcileChunks, type TermRef} from "./Sozluk.ts";

const term = (slug: string): TermRef => ({slug, title: slug});

interface Harness {
	readonly ports: SozlukReconcileScanPorts;
	/** Every `fetchChunk(afterSlug, limit)` call, in order — the paging trace. */
	readonly fetchCalls: Array<{afterSlug: string | null; limit: number}>;
	/** Every slug passed to `refreshTerm`, across all pages — the coverage trace. */
	readonly refreshed: string[];
}

/**
 * In-memory ports over a fixed, slug-sorted table: `fetchChunk` serves the keyset page
 * (`slug > afterSlug`, capped at `limit`) and records the cursor + limit it was asked for;
 * `refreshTerm` records every re-refreshed slug. This is the exact contract `reconcileCaches`
 * wires D1 into — so the driver's paging behavior is proven without a database.
 */
function harness(table: ReadonlyArray<string>): Harness {
	const sorted = [...table].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const fetchCalls: Array<{afterSlug: string | null; limit: number}> = [];
	const refreshed: string[] = [];
	const ports: SozlukReconcileScanPorts = {
		fetchChunk: (afterSlug, limit) =>
			Effect.sync(() => {
				fetchCalls.push({afterSlug, limit});
				return sorted
					.filter((s) => afterSlug === null || s > afterSlug)
					.slice(0, limit)
					.map(term);
			}),
		refreshTerm: (t) =>
			Effect.sync(() => {
				refreshed.push(t.slug);
			}),
	};
	return {ports, fetchCalls, refreshed};
}

describe("scanReconcileChunks — keyset-chunks the full reconciliation sweep (#2558)", () => {
	it.effect("a table larger than the chunk size is fully covered — every term is refreshed", () =>
		Effect.gen(function* () {
			const h = harness(["a", "b", "c", "d", "e"]);
			const result = yield* scanReconcileChunks(h.ports, 2);

			assert.strictEqual(result.scanned, 5, "every term is scanned across the pages");
			// A term in the THIRD page ("e") is refreshed just like "a" — no subset window.
			assert.deepStrictEqual(
				[...h.refreshed].sort(),
				["a", "b", "c", "d", "e"],
				"the sweep covers the whole table, not just the first chunk",
			);
		}),
	);

	it.effect("pages are bounded and the cursor advances strictly past each page's last slug", () =>
		Effect.gen(function* () {
			const h = harness(["a", "b", "c", "d", "e"]);
			yield* scanReconcileChunks(h.ports, 2);

			// Pages of [a,b],[c,d],[e] — the short third page (1 < 2) marks the tail, so no fourth
			// fetch. Each call asks for at most `chunkSize`, resuming at the prior last slug.
			assert.deepStrictEqual(
				h.fetchCalls,
				[
					{afterSlug: null, limit: 2},
					{afterSlug: "b", limit: 2},
					{afterSlug: "d", limit: 2},
				],
				"cursor walks null → b → d, limit stays chunkSize, short page terminates",
			);
		}),
	);

	it.effect("an exact-multiple table takes one extra empty page to terminate", () =>
		Effect.gen(function* () {
			const h = harness(["a", "b", "c", "d"]);
			const result = yield* scanReconcileChunks(h.ports, 2);

			assert.strictEqual(result.scanned, 4, "all four terms scanned");
			// Pages [a,b],[c,d] are both full, so the loop cannot know it is done until an empty
			// page after "d" — three fetches, the last returning zero rows.
			assert.deepStrictEqual(
				h.fetchCalls,
				[
					{afterSlug: null, limit: 2},
					{afterSlug: "b", limit: 2},
					{afterSlug: "d", limit: 2},
				],
				"a full final page forces one terminating empty fetch",
			);
		}),
	);

	it.effect("an empty table scans nothing and refreshes nothing in a single head fetch", () =>
		Effect.gen(function* () {
			const h = harness([]);
			const result = yield* scanReconcileChunks(h.ports, 2);

			assert.deepStrictEqual(result, {scanned: 0});
			assert.deepStrictEqual(h.fetchCalls, [{afterSlug: null, limit: 2}], "one empty head fetch");
			assert.deepStrictEqual(h.refreshed, []);
		}),
	);
});
