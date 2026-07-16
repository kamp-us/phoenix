/**
 * Tagged errors raised by the Mute service layer.
 *
 * `SelfMuteRejected` is the domain object refusing an invalid state — a member
 * muting themselves — at the write boundary (make-invalid-states-unrepresentable).
 * It carries no `FateWireCode`: a consuming service translates it at its own
 * boundary when the mutation surface lands (a sibling of this storage slice), so
 * the domain never asserts a wire code it doesn't yet have a wire for.
 */
import * as Schema from "effect/Schema";
import {UserId} from "../../lib/ids.ts";

export class SelfMuteRejected extends Schema.TaggedErrorClass<SelfMuteRejected>()(
	"mute/SelfMuteRejected",
	{
		memberId: UserId,
		message: Schema.String,
	},
) {}
