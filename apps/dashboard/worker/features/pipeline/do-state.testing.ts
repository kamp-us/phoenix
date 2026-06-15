/**
 * A node-pool platform fake of the `PipelineCacheState` slice (the KV `storage`
 * the cache DO instance touches), backing it with one `Map`. Lets a unit test
 * drive `makePipelineCacheInstance` without workerd (`.patterns/effect-testing.md`,
 * mirroring apps/web's `fate-live/do-state.testing.ts`).
 *
 * A factory `*.testing.ts` module never imported by the worker graph.
 */
import * as Effect from "effect/Effect";
import type {PipelineCacheState} from "./cache-do.ts";

export interface PipelineCacheStateForTest {
	readonly state: PipelineCacheState;
	/** The backing KV map — tests assert on what the instance persisted. */
	readonly kv: Map<string, unknown>;
}

/** Build a test cache state with its own KV `Map`. */
export function makePipelineCacheStateForTest(): PipelineCacheStateForTest {
	const kv = new Map<string, unknown>();

	// Each method is a generic `Effect` closure cast to its precise `Storage[...]`
	// member signature — member-typed casts, never `as any`, so the fake's shape
	// stays aligned with the real DO-state signature.
	type Storage = PipelineCacheState["storage"];

	const storage = {
		get: (<T>(key: string) => Effect.sync(() => kv.get(key) as T | undefined)) as Storage["get"],
		put: (<T>(key: string, value: T) =>
			Effect.sync(() => {
				kv.set(key, value);
			})) as Storage["put"],
	} as Storage;

	return {state: {storage}, kv};
}
