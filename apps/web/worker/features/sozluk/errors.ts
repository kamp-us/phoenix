/**
 * Tagged errors raised by the Sozluk service layer. Each carries its wire `code`
 * as an `ErrorCode` annotation, which `encodeWireError` reads at the fate
 * boundary (`.patterns/fate-effect-wire-errors.md`). The codes are preserved
 * verbatim from the retired bridge registry so SPA pattern-matching keeps
 * working unchanged; `errors.unit.test.ts` pins each class→code pair.
 */
import {ErrorCode} from "@kampus/fate-effect";
import * as Schema from "effect/Schema";

/** `body` was empty after trimming. */
export class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()(
	"sozluk/BodyRequired",
	{message: Schema.String},
	{[ErrorCode]: "BODY_REQUIRED"},
) {}

/** `body` exceeded `DEFINITION_BODY_MAX`. */
export class BodyTooLong extends Schema.TaggedErrorClass<BodyTooLong>()(
	"sozluk/BodyTooLong",
	{
		max: Schema.Number,
		message: Schema.String,
	},
	{[ErrorCode]: "BODY_TOO_LONG"},
) {}

export class DefinitionNotFound extends Schema.TaggedErrorClass<DefinitionNotFound>()(
	"sozluk/DefinitionNotFound",
	{
		definitionId: Schema.String,
		message: Schema.String,
	},
	{[ErrorCode]: "DEFINITION_NOT_FOUND"},
) {}

/** Caller is not the definition's author. */
export class UnauthorizedDefinitionMutation extends Schema.TaggedErrorClass<UnauthorizedDefinitionMutation>()(
	"sozluk/UnauthorizedDefinitionMutation",
	{
		definitionId: Schema.String,
		message: Schema.String,
	},
	{[ErrorCode]: "UNAUTHORIZED"},
) {}
