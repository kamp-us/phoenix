/**
 * `PipelineCache` — the cache seam the `Pipeline` service reads/writes through
 * (`.patterns/feature-services.md`, `effect-context-service.md`). One service, two
 * methods: `read` the last cached snapshot (or `null`), `write` a new one. The
 * production layer (`PipelineCacheLive`) addresses the `PipelineCacheDO` instance;
 * a test provides a `Layer.succeed` stub over the same tag (`.patterns/effect-testing.md`),
 * so the TTL/refresh/stale-on-error logic in `Pipeline` is exercised without workerd.
 *
 * Keeping the seam separate from the DO (and from the parser) is the #254 cut
 * point: `Pipeline` depends on this abstract cache, not on Cloudflare's DO API.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {PipelineCacheDO} from "./cache-do.ts";
import {type CachedPipelineState, encodeCachedPipelineState} from "./schema.ts";

/** The single instance name the snapshot lives under (one repo, one snapshot). */
const INSTANCE_NAME = "pipeline:kamp-us/phoenix";

export class PipelineCache extends Context.Service<
	PipelineCache,
	{
		/** The last cached snapshot, or `null` on a cold cache / undecodable blob. */
		readonly read: Effect.Effect<CachedPipelineState | null>;
		/** Persist a freshly-fetched snapshot as the new last-good value. */
		readonly write: (snapshot: CachedPipelineState) => Effect.Effect<void>;
	}
>()("@phoenix/dashboard/pipeline/PipelineCache") {}

export const PipelineCacheLive = Layer.effect(PipelineCache)(
	Effect.gen(function* () {
		const cache = yield* PipelineCacheDO;
		const stub = cache.getByName(INSTANCE_NAME);

		return {
			read: stub.read,
			// Encode at the seam so the DO stores plain JSON (a `Schema.Class` instance
			// would not survive the structured-clone round-trip through DO storage).
			write: (snapshot) =>
				encodeCachedPipelineState(snapshot).pipe(
					Effect.orDie,
					Effect.flatMap((encoded) => stub.write(encoded)),
				),
		};
	}),
);
