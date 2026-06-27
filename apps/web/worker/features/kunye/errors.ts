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
