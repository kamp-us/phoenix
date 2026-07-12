/**
 * Tagged errors raised by the flagship admin surface (#2741). The wire `code` annotation is
 * read by `encodeWireError` at the fate boundary (`.patterns/fate-effect-wire-errors.md`); the
 * shared `Denied` (invisible admin denial) is not redeclared here.
 */
import {FateWireCode} from "@kampus/fate-effect";
import * as Schema from "effect/Schema";

// A `flag.setOverride` for a key absent from the declared-flags registry — a bad request, so
// the override write never lands against an unknown/typo'd key (the audit log stays meaningful).
export class UnknownFlagKey extends Schema.TaggedErrorClass<UnknownFlagKey>()(
	"flagship/UnknownFlagKey",
	{message: Schema.String},
	{[FateWireCode]: "BAD_REQUEST"},
) {}
