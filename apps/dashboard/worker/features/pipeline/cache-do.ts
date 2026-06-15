/**
 * `PipelineCacheDO` — the cache substrate for the parsed pipeline snapshot (#254),
 * authored on alchemy's Effect DO model (ADR 0028, `.patterns/alchemy-durable-objects.md`).
 *
 * The cached data is a SINGLE small JSON snapshot keyed by repo, so a Durable
 * Object holding the last snapshot is the simplest durable home: one instance
 * (`PipelineCache.instanceName`), one KV key in `state.storage`, surviving across
 * isolates and refreshes — no schema/migration the way a D1 table for one blob
 * would demand. The DO is dumb storage: it persists/returns the bytes; the TTL
 * freshness + stale-on-error policy lives in `Pipeline.getState` (the seam #252
 * flagged), reading `Clock` so it's testable with `TestClock`.
 *
 * The instance body factors out as `makePipelineCacheInstance(state)` taking the
 * resolved `DurableObjectState` slice as a plain arg, so a node-pool unit test
 * drives it over the `do-state.testing.ts` fake without workerd.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import {type CachedPipelineState, decodeCachedPipelineState} from "./schema.ts";

/** The one KV key the snapshot lives under (single instance, single repo). */
const SNAPSHOT_KEY = "pipeline:snapshot";

type DurableObjectStateValue = Cloudflare.DurableObjectState["Service"];

/**
 * The slice of `DurableObjectState` the instance builder touches — just the KV
 * `storage`. Typed against this slice (not the whole state) so the node-pool fake
 * (`do-state.testing.ts`) satisfies it structurally with no cast.
 */
export type PipelineCacheState = Pick<DurableObjectStateValue, "storage">;

/**
 * The cache RPC surface: read the last snapshot (or `null` if none persisted yet)
 * and write a new one. The snapshot crosses the RPC boundary as the already-encoded
 * JSON value the DO stores verbatim; `read` decodes it back through the schema (the
 * stored bytes are a trust boundary across a DO restart / a deploy that changed the
 * shape — a stale-shaped blob fails the decode rather than corrupting the board).
 */
export interface PipelineCacheRpc {
	readonly read: Effect.Effect<CachedPipelineState | null, never, never>;
	readonly write: (snapshot: unknown) => Effect.Effect<void, never, never>;
}

export class PipelineCacheDO extends Cloudflare.DurableObjectNamespace<
	PipelineCacheDO,
	PipelineCacheRpc
>()("PipelineCacheDO") {}

/**
 * The per-instance cache algorithm over a resolved state slice. Plain-arg so a
 * unit test drives it over the `do-state.testing.ts` fake.
 *
 * `read` returns `null` (cache miss) for both "nothing stored" and "stored blob
 * no longer decodes" — a non-decodable snapshot is treated as absent so a shape
 * change degrades to a fresh fetch, never to a crash.
 */
export const makePipelineCacheInstance = (state: PipelineCacheState): PipelineCacheRpc => {
	const read = Effect.gen(function* () {
		const raw = yield* state.storage.get<unknown>(SNAPSHOT_KEY);
		if (raw === undefined) return null;
		return yield* decodeCachedPipelineState(raw).pipe(Effect.orElseSucceed(() => null));
	});

	const write = (snapshot: unknown) => state.storage.put(SNAPSHOT_KEY, snapshot);

	return {read, write};
};

export const PipelineCacheDOLive = PipelineCacheDO.make(
	// Two-phase per `.patterns/alchemy-durable-objects.md`: the shared-init phase
	// has no work (single instance, no self-addressing), so it's `Effect.succeed`
	// of the per-instance Effect — handed back UNRUN so alchemy runs it per
	// instance wake (the inner gen yields the resolved `DurableObjectState`).
	Effect.succeed(
		Effect.gen(function* () {
			const state = yield* Cloudflare.DurableObjectState;
			return makePipelineCacheInstance(state);
		}),
	),
);
