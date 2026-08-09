/**
 * The one tagged failure the group's impure legs carry in their `E` channel before folding it into a
 * value the verb can refuse on.
 *
 * Tagged rather than a bare `Error` so two legs' failures stay distinguishable in a composed effect —
 * the same discipline `../io/fs.ts` applies to reads.
 */
import * as Schema from "effect/Schema";

export class LegFailed extends Schema.TaggedErrorClass<LegFailed>()("fabrika-cli/ui/LegFailed", {
	reason: Schema.String,
}) {}

/** Lower an unknown thrown cause into the tagged failure, keeping its message. */
export const legFailed = (cause: unknown): LegFailed =>
	new LegFailed({reason: cause instanceof Error ? cause.message : String(cause)});
