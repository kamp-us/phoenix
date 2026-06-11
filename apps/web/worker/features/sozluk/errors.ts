/**
 * Tagged errors raised by the Sozluk service layer.
 *
 * Wire-code contract — every class carries its wire `code` as a
 * `ErrorCode` annotation (`.patterns/fate-effect-wire-errors.md`), which
 * `encodeWireError` reads at the fate boundary:
 *
 *   sozluk/BodyRequired                   → BODY_REQUIRED
 *   sozluk/BodyTooLong                    → BODY_TOO_LONG
 *   sozluk/DefinitionNotFound             → DEFINITION_NOT_FOUND
 *   sozluk/UnauthorizedDefinitionMutation → UNAUTHORIZED
 *
 * Mirrors the legacy `DefinitionValidationError` / `DefinitionNotFoundError` /
 * `UnauthorizedDefinitionMutationError` shapes that lived in `sozluk/module.ts`
 * pre-effect-migration. Wire codes preserved verbatim (they match the bridge's
 * retired registry entries exactly) so SPA pattern-matching keeps working
 * unchanged; `errors.unit.test.ts` pins each pair.
 */
import {ErrorCode} from "@phoenix/fate-effect";
import * as Schema from "effect/Schema";

/**
 * `body` field of `addDefinition` / `editDefinition` was empty after trimming.
 */
export class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()(
	"sozluk/BodyRequired",
	{message: Schema.String},
	{[ErrorCode]: "BODY_REQUIRED"},
) {}

/** `body` exceeded the configured maximum (`DEFINITION_BODY_MAX`). */
export class BodyTooLong extends Schema.TaggedErrorClass<BodyTooLong>()(
	"sozluk/BodyTooLong",
	{
		max: Schema.Number,
		message: Schema.String,
	},
	{[ErrorCode]: "BODY_TOO_LONG"},
) {}

/**
 * Raised by every mutation that targets a `definition_view` row that doesn't
 * exist (or has been soft-deleted in cases where existence is required).
 */
export class DefinitionNotFound extends Schema.TaggedErrorClass<DefinitionNotFound>()(
	"sozluk/DefinitionNotFound",
	{
		definitionId: Schema.String,
		message: Schema.String,
	},
	{[ErrorCode]: "DEFINITION_NOT_FOUND"},
) {}

/**
 * Raised by `editDefinition` / `deleteDefinition` when the calling user is not
 * the row's author.
 */
export class UnauthorizedDefinitionMutation extends Schema.TaggedErrorClass<UnauthorizedDefinitionMutation>()(
	"sozluk/UnauthorizedDefinitionMutation",
	{
		definitionId: Schema.String,
		message: Schema.String,
	},
	{[ErrorCode]: "UNAUTHORIZED"},
) {}
