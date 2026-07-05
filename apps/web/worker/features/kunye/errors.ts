/**
 * The künye wire-coded authz denials (ADR 0107 §5) — `Schema.TaggedErrorClass`
 * with a `FateWireCode` annotation, so `encodeWireError` derives the wire shape
 * with no registry edit, the same path as `fate-effect/Unauthorized` and
 * `report/NotAModerator`. Their two codes are the deliberate asymmetry of the
 * two authority axes (per-class below).
 */
import {FateWireCode} from "@kampus/fate-effect";
import * as Schema from "effect/Schema";

/**
 * An assigned-authority (ReBAC) check failed — the actor lacks the relation, or
 * is anonymous. `UNAUTHORIZED` so the denial is indistinguishable from the
 * anonymous case (the invisible-denial invariant, ADR 0098 §2 carried forward).
 */
export class Denied extends Schema.TaggedErrorClass<Denied>()(
	"kunye/Denied",
	{message: Schema.String},
	{[FateWireCode]: "UNAUTHORIZED"},
) {}

/**
 * An earned-ladder (Level) check failed — the actor's standing is below the
 * floor, or is anonymous. `FORBIDDEN`, carrying the `need`ed rank so the public
 * ladder is a visible progression.
 */
export class RequiresLevel extends Schema.TaggedErrorClass<RequiresLevel>()(
	"kunye/RequiresLevel",
	{message: Schema.String, need: Schema.String},
	{[FateWireCode]: "FORBIDDEN"},
) {}

/**
 * The concurrent-vouch cap (D5, `VOUCH_CONCURRENT_CAP`) is reached — a yazar already
 * holds the maximum active vouches and is denied a further one until a slot frees
 * (the vouched çaylak is promoted, or the voucher withdraws). Distinct from the two
 * authority denials above: the actor IS a yazar (they cleared the `Vouch` floor),
 * the act is just rate-limited, so it carries its own `VOUCH_LIMIT_REACHED` code and
 * the `cap` so the surface can show "you've used all N of your vouches."
 */
export class VouchLimitReached extends Schema.TaggedErrorClass<VouchLimitReached>()(
	"kunye/VouchLimitReached",
	{message: Schema.String, cap: Schema.Number},
	{[FateWireCode]: "VOUCH_LIMIT_REACHED"},
) {}

/**
 * A karma-VALUE privilege floor (#150) failed — the actor's earned `total_karma`
 * is below a right's minimum. Distinct from {@link RequiresLevel}, which floors
 * the çaylak→yazar authorship *tier*: this floors a raw karma count (post ≥ −4,
 * flag ≥ 50), an anti-abuse gate orthogonal to the tier ladder — so it carries
 * its OWN `INSUFFICIENT_KARMA` code (not the overloaded `FORBIDDEN`) and the
 * `need`ed floor + the actor's current `have`, so the surface can name the bar
 * ("−4 karmanın altındasın") without mislabelling a tier denial. Visible (a
 * FORBIDDEN-family public-progression denial), never the invisible {@link Denied}
 * — a downvoted-into-the-ground poster deserves a clear reason, not a silent
 * no-op. Reconciled with the tier model + ADR 0098 (no double-gating): the karma
 * floors are a separate axis from authorship-tier and from moderation authority.
 */
export class InsufficientKarma extends Schema.TaggedErrorClass<InsufficientKarma>()(
	"kunye/InsufficientKarma",
	{message: Schema.String, need: Schema.Number, have: Schema.Number},
	{[FateWireCode]: "INSUFFICIENT_KARMA"},
) {}
