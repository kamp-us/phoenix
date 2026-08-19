/**
 * Stats root query resolvers (`.patterns/fate-effect-operations.md`). Both are anonymous
 * reads; `health` is string-typed by design so it stays off `Root`.
 */

import {Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import {Stats} from "./Stats.ts";

export interface Health {
	readonly status: "ok";
	readonly definitions: number;
}

const PHOENIX_BUILD_VERSION = "v0.3";

// Stable, so the client normalizes the singleton to one cache record.
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
		// A type-name STRING, not `LandingStatsView`: a view-typed query would make the
		// entity view-reachable and trip source-completeness validation, but this is a
		// synthetic singleton whose only producer is the resolver below.
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
