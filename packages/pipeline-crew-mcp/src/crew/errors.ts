/**
 * crew/errors — the typed failures the crew composition root raises. The one non-obvious
 * thing: a role-uniqueness collision is a REJECTION (a typed error), not a value — a second
 * live session for a held role must not silently co-occupy it, so the wiring fails loudly.
 * A resource claim/collision-check, by contrast, answers with a value (`ClaimReply`), never
 * this error — that collision is a normal answer, not a rejection.
 */
import {Schema} from "effect";

/** A second live session tried to hold a role another session already holds — rejected, not shared. */
export class RoleUniquenessError extends Schema.TaggedErrorClass<RoleUniquenessError>()(
	"@kampus/pipeline-crew-mcp/crew/RoleUniquenessError",
	{
		role: Schema.String,
		heldBy: Schema.String,
	},
) {}
