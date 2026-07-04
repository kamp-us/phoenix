/**
 * The storage seam — the doorman's view of R2, narrowed to exactly the two ops
 * write-once needs: `head` (does this content-address already exist?) and `put`
 * (store it). Narrowing to a seam (not the raw R2 client) is what lets the upload
 * orchestrator's write-once decision unit-test with a scripted in-memory store,
 * with no live bucket (`.patterns/effect-testing.md` unit tier; the R2-put seam is
 * the unit-tier Drizzle-seam analogue).
 *
 * The Live implementation wraps the alchemy `ReadWriteBucketClient` and is wired in
 * `worker/index.ts`, where the bucket binding and its `RuntimeContext` are in scope.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type {StorageError} from "./errors.ts";

export interface StoredObject {
	/** The object's stored size in bytes — used to short-circuit a byte-identical re-PUT. */
	readonly size: number;
}

export interface StorageService {
	/** The object at `key`, or `null` if the key is free. */
	readonly head: (key: string) => Effect.Effect<StoredObject | null, StorageError>;
	/** Write `bytes` at `key` with the given content type. */
	readonly put: (
		key: string,
		bytes: Uint8Array,
		contentType: string,
	) => Effect.Effect<void, StorageError>;
}

export class Storage extends Context.Service<Storage, StorageService>()("depo/Storage") {}
