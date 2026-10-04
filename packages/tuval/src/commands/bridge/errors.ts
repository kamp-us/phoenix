import {Schema} from "effect";

/**
 * The bridge's allowlist refused the path. Capability enforcement is a later epic (#7617 R1.6), so
 * the allowlist is the only thing standing between a calling program and the whole registry — and
 * it is data the caller's own row supplies, not a check the kernel makes on the caller's identity.
 */
export class SpellNotAllowed extends Schema.TaggedError<SpellNotAllowed>()(
	"tuval/commands/SpellNotAllowed",
	{path: Schema.String},
) {
	override get message(): string {
		return `the calling program's bridge does not allow "${this.path}"`;
	}
}
