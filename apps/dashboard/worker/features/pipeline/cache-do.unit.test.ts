/**
 * T0 unit test for the cache DO instance algorithm (`makePipelineCacheInstance`),
 * driven over the KV `storage` fake (`do-state.testing.ts`) — no workerd
 * (`.patterns/effect-testing.md`). The DO is dumb storage: read returns the last
 * snapshot or `null`, write persists; a stored blob that no longer decodes reads
 * back as `null` (a shape change degrades to a cache miss, never a crash).
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
			assert.strictEqual(yield* cache.read, null);
		}),
	);

	it.effect("round-trips a written snapshot", () =>
		Effect.gen(function* () {
			const {state} = makePipelineCacheStateForTest();
			const cache = makePipelineCacheInstance(state);

			const encoded = yield* encodeCachedPipelineState(snapshot);
			yield* cache.write(encoded);
			const read = yield* cache.read;

			assert.isNotNull(read);
			assert.strictEqual(read!.fetchedAt, snapshot.fetchedAt);
			assert.isTrue(read!.state instanceof PipelineState);
		}),
	);

	it.effect("reads null when the stored blob no longer decodes", () =>
		Effect.gen(function* () {
			const {state, kv} = makePipelineCacheStateForTest();
			const cache = makePipelineCacheInstance(state);

			// A blob from an older/different shape — write it under the snapshot key.
			kv.set("pipeline:snapshot", {garbage: true});
			assert.strictEqual(yield* cache.read, null);
		}),
	);
});
