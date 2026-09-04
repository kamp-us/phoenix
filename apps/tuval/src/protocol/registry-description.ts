/**
 * The spell registry as it rides in a `Snapshot`: one serializable row per spell.
 *
 * The registry itself (#7636) is a sibling of this module and the founder's 2026-09-03 walk on
 * #7637 keeps the two independent — they meet only in the executor (#7638) — so the description is
 * declared here structurally rather than imported. `params` is the spell's own parameter schema
 * rendered as JSON Schema: the page completes and validates against it without holding the schema
 * value, and the executor still decodes the real arguments against the spell's `params`.
 *
 * `capabilities` mirrors the kernel's inert `CapabilityRequest` record (`src/registry/program.ts`):
 * requested is all it is, nothing grants or denies it (#7617 R1.6).
 */

import {Schema} from "effect";
import {SpellPath} from "./ids.ts";

export const CapabilityFamily = Schema.Literals([
	"filesystem",
	"network",
	"process",
	"model",
	"github",
	"process-control",
]);
export type CapabilityFamily = typeof CapabilityFamily.Type;

export const CapabilityRequest = Schema.Struct({
	family: CapabilityFamily,
	detail: Schema.optionalKey(Schema.String),
});
export type CapabilityRequest = typeof CapabilityRequest.Type;

export const SpellDescription = Schema.Struct({
	path: SpellPath,
	/** One sentence, user-facing twice: the palette's inline description and `help` (#7617 R2.1). */
	describe: Schema.String,
	/** The spell's `params` as JSON Schema. */
	params: Schema.Unknown,
	capabilities: Schema.Array(CapabilityRequest),
});
export type SpellDescription = typeof SpellDescription.Type;

export const RegistryDescription = Schema.Array(SpellDescription);
export type RegistryDescription = typeof RegistryDescription.Type;
