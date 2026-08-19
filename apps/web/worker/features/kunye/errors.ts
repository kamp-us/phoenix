/**
 * The künye wire-coded authz denials (ADR 0107 §5). The `FateWireCode` annotation lets
 * `encodeWireError` derive the wire shape with no registry edit; the codes below differ
 * deliberately, one per authority axis.
 */
import {FateWireCode} from "@kampus/fate-effect";
import * as Schema from "effect/Schema";

/**
 * An assigned-authority (ReBAC) check failed. `UNAUTHORIZED` so the denial is
 * indistinguishable from the anonymous case (ADR 0098 §2's invisible denial).
 */
export class Denied extends Schema.TaggedErrorClass<Denied>()(
	"kunye/Denied",
	{message: Schema.String},
	{[FateWireCode]: "UNAUTHORIZED"},
) {}

/**
 * An earned-ladder (Level) check failed. `FORBIDDEN`, carrying the `need`ed rank so the
 * public ladder stays a visible progression.
 */
export class RequiresLevel extends Schema.TaggedErrorClass<RequiresLevel>()(
	"kunye/RequiresLevel",
	{message: Schema.String, need: Schema.String},
	{[FateWireCode]: "FORBIDDEN"},
) {}

/**
 * The concurrent-vouch cap is reached. Not an authority denial — the actor IS a yazar,
 * the act is rate-limited — so it carries its own code and the `cap` for the copy.
 */
export class VouchLimitReached extends Schema.TaggedErrorClass<VouchLimitReached>()(
	"kunye/VouchLimitReached",
	{message: Schema.String, cap: Schema.Number},
	{[FateWireCode]: "VOUCH_LIMIT_REACHED"},
) {}

/**
 * A karma-VALUE privilege floor failed. Distinct from {@link RequiresLevel}, which floors
 * the çaylak→yazar tier: this floors a raw karma count, an anti-abuse gate orthogonal to
 * the ladder — so it carries its OWN code plus `need`/`have` for the copy. Visible, never
 * the invisible {@link Denied}: a downvoted poster deserves a reason, not a silent no-op.
 */
export class InsufficientKarma extends Schema.TaggedErrorClass<InsufficientKarma>()(
	"kunye/InsufficientKarma",
	{message: Schema.String, need: Schema.Number, have: Schema.Number},
	{[FateWireCode]: "INSUFFICIENT_KARMA"},
) {}
