/**
 * T0 unit test for the cache DO instance algorithm (`makePipelineCacheInstance`),
 * driven over the KV `storage` fake (`do-state.testing.ts`) — no workerd
 * (`.patterns/effect-testing.md`). The DO is DUMB storage: `read` returns the raw
 * stored value verbatim (plain JSON, or `null` when nothing is stored), `write`
 * persists. It does NOT decode — a `CachedPipelineState` instance isn't
 * RPC-serializable, so the schema round-trip lives worker-side in `PipelineCache`
 * (#323). The decode + stale-blob-degrade behavior is tested there.
 */
import {assert, describe, it} from "@effect/vitest";
import * as Effect from "effect/Effect";
import {makePipelineCacheInstance} from "./cache-do.ts";
import {makePipelineCacheStateForTest} from "./do-state.testing.ts";
import {CachedPipelineState, encodeCachedPipelineState, PipelineState} from "./schema.ts";

const snapshot = new CachedPipelineState({
	state: new PipelineState({issues: [], epics: []}),
	fetchedAt: 1_700_000_000_000,
});

describe("makePipelineCacheInstance", () => {
	it.effect("reads null on a cold cache", () =>
		Effect.gen(function* () {
			const {state} = makePipelineCacheStateForTest();
			const cache = makePipelineCacheInstance(state);
			assert.strictEqual(yield* cache.read(), null);
		}),
	);

	it.effect("read returns the raw stored value verbatim (no decode)", () =>
		Effect.gen(function* () {
			const {state} = makePipelineCacheStateForTest();
			const cache = makePipelineCacheInstance(state);

			const encoded = yield* encodeCachedPipelineState(snapshot);
			yield* cache.write(encoded);
			const read = yield* cache.read();

			// The DO hands back the exact plain JSON it stored — NOT a decoded class
			// instance (which Cloudflare RPC can't serialize). `deepStrictEqual` against
			// the encoded plain object asserts the verbatim pass-through.
			assert.deepStrictEqual(read, encoded);
		}),
	);

	it.effect("read passes through an unknown blob verbatim (decode is worker-side)", () =>
		Effect.gen(function* () {
			const {state, kv} = makePipelineCacheStateForTest();
			const cache = makePipelineCacheInstance(state);

			// A blob from an older/different shape — the DO does not validate it; it returns
			// it verbatim and the worker-side seam (`PipelineCache`) degrades it to a miss.
			kv.set("pipeline:snapshot", {garbage: true});
			assert.deepStrictEqual(yield* cache.read(), {garbage: true});
		}),
	);
});
