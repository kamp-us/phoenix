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
 * The cache RPC surface: read the last stored snapshot value (or `null` if none) and
 * write a new one. Both cross the RPC boundary as PLAIN JSON the DO stores verbatim —
 * `read` returns the raw stored value, NOT a decoded `CachedPipelineState`. Cloudflare
 * RPC can only serialize structured-cloneable values, and a `Schema.Class` instance is
 * not one ("Could not serialize object of type CachedPipelineState" — #323); the
 * schema round-trip therefore lives WORKER-side in `PipelineCache` (encode before
 * `write`, decode after `read`), where the value stays in-process. The DO is dumb
 * storage: bytes in, bytes out.
 *
 * Every member is a METHOD (`read()`, `write(s)`) — never a bare-Effect property. The
 * alchemy RPC stub proxies every member access as a callable and invokes it
 * (`stub[member](...args)`), so a non-callable `read: Effect` resolves to the proxy
 * function itself, never the Effect: `Effect.suspend(() => stub().read)` then dies with
 * "Not a valid effect" at request time (#323). The nullary thunk keeps `read` callable
 * on both ends of the boundary.
 */
export interface PipelineCacheRpc {
	readonly read: () => Effect.Effect<unknown, never, never>;
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
 * `read` returns the raw stored value verbatim — plain JSON (or `null` when nothing
 * is stored), never a decoded class instance: the schema decode is the worker-side
 * seam's job (`PipelineCache`), so only RPC-serializable values cross the boundary
 * (#323). The "stale-shaped blob → cache miss" degrade also lives there.
 */
export const makePipelineCacheInstance = (state: PipelineCacheState): PipelineCacheRpc => {
	const read = () =>
		Effect.gen(function* () {
			const raw = yield* state.storage.get<unknown>(SNAPSHOT_KEY);
			return raw === undefined ? null : raw;
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
