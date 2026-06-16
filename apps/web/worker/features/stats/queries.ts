/**
 * Stats root query resolvers — `health`, `landingStats`
 * (`.patterns/fate-effect-operations.md`).
 *
 * `health` is string-typed (no data view by design) so it stays off `Root`
 * but still dispatches over the native transport. Both roots are anonymous
 * reads (no `CurrentUser`); infra failures die inside `Stats`, never reaching
 * this layer (`.patterns/feature-services.md`).
 */

import {Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import {Stats} from "./Stats.ts";

export interface Health {
	readonly status: "ok";
	readonly definitions: number;
}

const PHOENIX_BUILD_VERSION = "v0.3";

// Stable id for the singleton entity, so the client normalizes it to one cache
// record (see views.ts).
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
		// Wire type-name STRING, not `LandingStatsView`: a view-typed query would
		// make the entity view-reachable and trip source-completeness validation,
		// but `LandingStats` is a synthetic singleton with no fetch path (the
		// resolver is its only producer). Codegen is unchanged — the client root
		// still types off `Root`'s `landingStatsDataView` + this handler.
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
