/**
 * mecmua write-path errors (#2497); see `.patterns/fate-effect-wire-errors.md`.
 *
 * The publish yazar-floor denial is NOT here — it is künye's shared `RequiresLevel`, so
 * the earned-ladder denial copy lives once at the capability.
 */
import {FateWireCode} from "@kampus/fate-effect";
import * as Schema from "effect/Schema";

/**
 * Dark-ship containment (ADR 0083): both write mutations fail this with the flag off, so
 * the write path is unreachable even if a client bypasses the UI.
 */
export class MecmuaDisabled extends Schema.TaggedError<MecmuaDisabled>()(
	"mecmua/MecmuaDisabled",
	{message: Schema.String},
	{[FateWireCode]: "MECMUA_DISABLED"},
) {}

/** The draft doesn't exist, or isn't the caller's own — the ownership-scoped miss. */
export class MecmuaPostNotFound extends Schema.TaggedError<MecmuaPostNotFound>()(
	"mecmua/MecmuaPostNotFound",
	{message: Schema.String},
	{[FateWireCode]: "MECMUA_POST_NOT_FOUND"},
) {}

export class MecmuaTitleRequired extends Schema.TaggedError<MecmuaTitleRequired>()(
	"mecmua/MecmuaTitleRequired",
	{message: Schema.String},
	{[FateWireCode]: "TITLE_REQUIRED"},
) {}
