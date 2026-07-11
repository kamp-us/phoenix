/**
 * mecmua write-path errors (#2497). Each is a `Schema.TaggedErrorClass` carrying its
 * wire `code` as an `FateWireCode` annotation `encodeWireError` reads at the fate
 * boundary (`.patterns/fate-effect-wire-errors.md`), the same shape as pano's.
 *
 * The publish yazar-floor denial is NOT here — it is the shared künye
 * {@link ../kunye/errors.ts | RequiresLevel} (`FORBIDDEN`) minted by
 * {@link ../mecmua/PublishMecmua.ts | PublishMecmua}, so the earned-ladder denial
 * copy lives once at the capability, not duplicated per feature.
 */
import {FateWireCode} from "@kampus/fate-effect";
import * as Schema from "effect/Schema";

/**
 * The mecmua flag is off (dark-ship, ADR 0083). Both `mecmua.publish` and
 * `mecmua.saveDraft` fail this with the flag off, so the write path is unreachable
 * even if a client bypasses the (not-yet-built) UI — the load-bearing containment.
 */
export class MecmuaDisabled extends Schema.TaggedErrorClass<MecmuaDisabled>()(
	"mecmua/MecmuaDisabled",
	{message: Schema.String},
	{[FateWireCode]: "MECMUA_DISABLED"},
) {}

/** A publish target draft doesn't exist, or isn't the caller's own — the ownership-scoped miss. */
export class MecmuaPostNotFound extends Schema.TaggedErrorClass<MecmuaPostNotFound>()(
	"mecmua/MecmuaPostNotFound",
	{message: Schema.String},
	{[FateWireCode]: "MECMUA_POST_NOT_FOUND"},
) {}

/** A publish with an empty title — a published yazı needs a başlık. */
export class MecmuaTitleRequired extends Schema.TaggedErrorClass<MecmuaTitleRequired>()(
	"mecmua/MecmuaTitleRequired",
	{message: Schema.String},
	{[FateWireCode]: "TITLE_REQUIRED"},
) {}
