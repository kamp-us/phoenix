/**
 * Stats root query resolvers — `health`, `landingStats`.
 *
 * `Fate.query` def + `Effect.fn("<wire name>")` pairs over `Stats`
 * (`.patterns/fate-effect-operations.md`).
 *
 * Roots:
 *   - `health` — the trivial seam-proof root (sanity check + total-definitions
 *     counter the smoke tests assert against). String-typed (`type: "Health"`):
 *     it has no data view by design, so it stays off `Root` (codegen-invisible)
 *     but lives in this record for the native transport to dispatch.
 *   - `landingStats` — the landing-page stats card. Reads the single-row
 *     aggregates + cross-product distinct-author union via
 *     `Stats.getLandingStats`, plus the build `version` the SPA renders. Returns
 *     the `LandingStats` entity stamped with a constant `id` so the client
 *     normalizes it to a single cache record.
 *
 * Both are plain anonymous reads (no `CurrentUser`). Infra failures never
 * reach this layer — they die inside the domain service (the boundary rule in
 * `.patterns/feature-services.md`).
 */

import {Fate} from "@phoenix/fate-effect";
import {Effect} from "effect";
import {Stats} from "./Stats.ts";

export interface Health {
	readonly status: "ok";
	readonly definitions: number;
}

/** Build tag the landing card renders. */
const PHOENIX_BUILD_VERSION = "v0.3";

/**
 * Constant id for the singleton `LandingStats` entity. There is only ever one
 * landing-stats row; the client normalizes by `record.id`, so a stable id keeps
 * it a single cache record.
 */
const LANDING_STATS_ID = "landing";

export const queries = {
	health: Fate.query(
		{type: "Health"},
		Effect.fn("health")(function* () {
			const stats = yield* Stats;
			const {totalDefinitions} = yield* stats.getLandingStats();
			return {status: "ok", definitions: totalDefinitions} satisfies Health;
		}),
	),
	landingStats: Fate.query(
		// The wire type-name STRING, not `LandingStatsView`: a view-typed query
		// makes its entity view-reachable, and the server's source-completeness
		// validation then demands a source — but `LandingStats` is a singleton
		// synthetic entity with no fetch path (no source by design; the resolver
		// is its only producer). The string ref is exactly the bridge-era shape;
		// the client root still types itself off `Root`'s `landingStatsDataView`
		// + this handler's success type, so codegen is unchanged.
		{type: "LandingStats"},
		Effect.fn("landingStats")(function* () {
			const stats = yield* Stats;
			const result = yield* stats.getLandingStats();
			return {
				__typename: "LandingStats",
				id: LANDING_STATS_ID,
				...result,
				version: PHOENIX_BUILD_VERSION,
			};
		}),
	),
};
