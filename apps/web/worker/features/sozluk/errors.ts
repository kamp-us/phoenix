/**
 * Tagged errors raised by the Sozluk service layer.
 *
 * Wire-code contract — every tag in this file maps to a specific
 * `code` string via `worker/features/fate/errors.ts::encodeFateError`:
 *
 *   sozluk/BodyRequired                   → BODY_REQUIRED
 *   sozluk/BodyTooLong                    → BODY_TOO_LONG
 *   sozluk/DefinitionNotFound             → DEFINITION_NOT_FOUND
 *   sozluk/UnauthorizedDefinitionMutation → UNAUTHORIZED
 *
 * Mirrors the legacy `DefinitionValidationError` / `DefinitionNotFoundError` /
 * `UnauthorizedDefinitionMutationError` shapes that lived in `sozluk/module.ts`
 * pre-effect-migration. Wire codes preserved verbatim so SPA pattern-matching
 * keeps working unchanged.
 */
import * as Schema from "effect/Schema";

/**
 * `body` field of `addDefinition` / `editDefinition` was empty after trimming.
 * Maps to `BODY_REQUIRED`.
 */
export class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()("sozluk/BodyRequired", {
	message: Schema.String,
}) {}

/**
 * `body` exceeded the configured maximum (`DEFINITION_BODY_MAX`). Maps to
 * `BODY_TOO_LONG`.
 */
export class BodyTooLong extends Schema.TaggedErrorClass<BodyTooLong>()("sozluk/BodyTooLong", {
	max: Schema.Number,
	message: Schema.String,
}) {}

/**
 * Raised by every mutation that targets a `definition_view` row that doesn't
 * exist (or has been soft-deleted in cases where existence is required). Maps
 * to `DEFINITION_NOT_FOUND`.
 */
export class DefinitionNotFound extends Schema.TaggedErrorClass<DefinitionNotFound>()(
	"sozluk/DefinitionNotFound",
	{
		definitionId: Schema.String,
		message: Schema.String,
	},
) {}

/**
 * Raised by `editDefinition` / `deleteDefinition` when the calling user is not
 * the row's author. Maps to `UNAUTHORIZED`.
 */
export class UnauthorizedDefinitionMutation extends Schema.TaggedErrorClass<UnauthorizedDefinitionMutation>()(
	"sozluk/UnauthorizedDefinitionMutation",
	{
		definitionId: Schema.String,
		message: Schema.String,
	},
) {}
