/**
 * The `ModelCost` projection at the adapter boundary.
 *
 * Pi's own cost carries an optional `tiers` array (`@earendil-works/pi-ai`
 * `dist/types.d.ts:691-694`: `ModelCost extends ModelCostRates` plus `tiers?: ModelCostTier[]`).
 * Tuval's own `ModelCost` (`../wire/model.ts`) is exactly the four rates. Protocol 8 carries the
 * payload opaque, so nothing on the wire refuses a tiered cost any more — which makes this
 * projection the only thing keeping one off it, rather than a second line of defence.
 */

import type {ModelMetadata} from "../wire/index.ts";

export type ProtocolModelCost = ModelMetadata["cost"];

/** Pi's shape, restated structurally so this module does not depend on which package declares it. */
export interface SourceModelCost {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly tiers?: ReadonlyArray<unknown> | undefined;
}

export const projectModelCost = (cost: SourceModelCost): ProtocolModelCost => ({
	input: cost.input,
	output: cost.output,
	cacheRead: cost.cacheRead,
	cacheWrite: cost.cacheWrite,
});
