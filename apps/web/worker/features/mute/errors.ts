/**
 * Tagged errors raised by the Mute service + its fate write path.
 *
 * `SelfMuteRejected` is the domain object refusing an invalid state — a member
 * muting themselves — at the write boundary (make-invalid-states-unrepresentable).
 * It now carries its `FateWireCode` because the `mute.set` / `mute.remove` mutation
 * surface (#3112) is the consuming boundary that landed: `encodeWireError` reads the
 * annotation at the fate seam (`.patterns/fate-effect-wire-errors.md`), the same shape
 * as pano's / mecmua's.
 *
 * `MuteDisabled` is the dark-ship containment (ADR 0083): with the `member-mute` flag
 * off both mutations fail this before any read/write, so the primitive is unreachable
 * even if a client bypasses the (not-yet-built) UI — mirrors `MecmuaDisabled`.
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
