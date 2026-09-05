/**
 * The `ModelCost` projection at the adapter boundary.
 *
 * Pi's own cost carries an optional `tiers` array (`@earendil-works/pi-ai`
 * `dist/types.d.ts:691-694`: `ModelCost extends ModelCostRates` plus `tiers?: ModelCostTier[]`).
 * The wire's `ModelCostSchema` is a strict object of exactly the four rates
 * (`@earendil-works/pi-protocol` `dist/schemas.js`, `StrictObject` = `additionalProperties: false`),
 * so handing Pi's cost straight to `encodeServerMessage` fails validation the moment a model is
 * priced in tiers. Only the four fields cross, and this is the one place that decides that.
 */

import type {ModelMetadata} from "@earendil-works/pi-protocol";

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
