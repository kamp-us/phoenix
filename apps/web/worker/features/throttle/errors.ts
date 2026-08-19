import {FateWireCode} from "@kampus/fate-effect";
import * as Schema from "effect/Schema";

/**
 * The per-actor mutation budget is exhausted (ADR 0177). Unlike
 * `kunye/VouchLimitReached`, which rations one domain act, this bounds an actor's
 * aggregate write volume across every feature at the fate seam.
 */
export class RateLimitExceeded extends Schema.TaggedErrorClass<RateLimitExceeded>()(
	"throttle/RateLimitExceeded",
	{message: Schema.String, retryAfterMs: Schema.Number},
	{[FateWireCode]: "RATE_LIMIT_EXCEEDED"},
) {}
