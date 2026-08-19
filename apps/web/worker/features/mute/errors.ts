/**
 * Mute's tagged errors. `MuteDisabled` is the dark-ship containment (ADR 0083): with the
 * `member-mute` flag off both mutations fail this before any read or write, so the
 * primitive is unreachable even if a client bypasses the UI. Wire codes:
 * `.patterns/fate-effect-wire-errors.md`.
 */
import {FateWireCode} from "@kampus/fate-effect";
import * as Schema from "effect/Schema";
import {UserId} from "../../lib/ids.ts";

export class SelfMuteRejected extends Schema.TaggedErrorClass<SelfMuteRejected>()(
	"mute/SelfMuteRejected",
	{
		memberId: UserId,
		message: Schema.String,
	},
	{[FateWireCode]: "SELF_MUTE_REJECTED"},
) {}

export class MuteDisabled extends Schema.TaggedErrorClass<MuteDisabled>()(
	"mute/MuteDisabled",
	{message: Schema.String},
	{[FateWireCode]: "MUTE_DISABLED"},
) {}
