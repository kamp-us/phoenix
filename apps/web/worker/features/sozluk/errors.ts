/**
 * Each error's `FateWireCode` annotation is what `encodeWireError` reads at the fate
 * boundary (`.patterns/fate-effect-wire-errors.md`). The codes are SPA-visible, so
 * `errors.unit.test.ts` pins each class→code pair.
 */
import {FateWireCode} from "@kampus/fate-effect";
import * as Schema from "effect/Schema";

export class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()(
	"sozluk/BodyRequired",
	{message: Schema.String},
	{[FateWireCode]: "BODY_REQUIRED"},
) {}

export class BodyTooLong extends Schema.TaggedErrorClass<BodyTooLong>()(
	"sozluk/BodyTooLong",
	{
		max: Schema.Number,
		message: Schema.String,
	},
	{[FateWireCode]: "BODY_TOO_LONG"},
) {}

export class DefinitionNotFound extends Schema.TaggedErrorClass<DefinitionNotFound>()(
	"sozluk/DefinitionNotFound",
	{
		definitionId: Schema.String,
		message: Schema.String,
	},
	{[FateWireCode]: "DEFINITION_NOT_FOUND"},
) {}

export class UnauthorizedDefinitionMutation extends Schema.TaggedErrorClass<UnauthorizedDefinitionMutation>()(
	"sozluk/UnauthorizedDefinitionMutation",
	{
		definitionId: Schema.String,
		message: Schema.String,
	},
	{[FateWireCode]: "UNAUTHORIZED"},
) {}
