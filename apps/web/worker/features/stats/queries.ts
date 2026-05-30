/**
 * Stats root query resolvers — `health`, `landingStats`.
 *
 * Thin orchestration over `Stats`, wrapped by `fateQuery` so it runs through
 * the request runtime (see `.patterns/fate-effect-bridge.md`).
 *
 * Roots:
 *   - `health` — the trivial seam-proof root (sanity check + total-definitions
 *     counter the smoke tests assert against).
 *   - `landingStats` — the landing-page stats card. Reads the single-row
 *     aggregates + cross-product distinct-author union via
 *     `Stats.getLandingStats`, plus the build `version` the SPA renders. Returns
 *     the `LandingStats` entity stamped with a constant `id` so the client
 *     normalizes it to a single cache record.
 */

import {fateQuery} from "../fate/effect.ts";
import type {LandingStats} from "../fate/views.ts";
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
	health: {
		type: "Health",
		resolve: fateQuery<undefined, Health>(function* () {
			const stats = yield* Stats;
			const {totalDefinitions} = yield* stats.getLandingStats();
			return {status: "ok", definitions: totalDefinitions} satisfies Health;
		}),
	},
	landingStats: {
		type: "LandingStats",
		resolve: fateQuery<undefined, LandingStats>(function* () {
			const stats = yield* Stats;
			const result = yield* stats.getLandingStats();
			return {
				__typename: "LandingStats",
				id: LANDING_STATS_ID,
				...result,
				version: PHOENIX_BUILD_VERSION,
			};
		}),
	},
};
