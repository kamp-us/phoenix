/**
 * The throttle wire-coded denial (ADR 0177) — a `Schema.TaggedErrorClass` with a
 * `FateWireCode` annotation, so `encodeWireError` derives the wire shape with no
 * registry edit, the same path as `kunye/VouchLimitReached`. Distinct from that
 * business cap: `VOUCH_LIMIT_REACHED` rations one domain act (concurrent
 * vouches), whereas this bounds an actor's aggregate mutation *volume* across
 * every feature at the fate seam.
 */
import {FateWireCode} from "@kampus/fate-effect";
import * as Schema from "effect/Schema";

/**
 * The per-actor mutation budget is exhausted — the actor is issuing writes
 * faster than the token bucket refills. Carries `retryAfterMs` so the surface
 * can name the wait; its own `RATE_LIMIT_EXCEEDED` code (not a generic 500) so a
 * throttled write is a clear, distinguishable denial.
 */
export class RateLimitExceeded extends Schema.TaggedErrorClass<RateLimitExceeded>()(
	"throttle/RateLimitExceeded",
	{message: Schema.String, retryAfterMs: Schema.Number},
	{[FateWireCode]: "RATE_LIMIT_EXCEEDED"},
) {}
