/**
 * Tagged errors raised by the Pasaport service layer.
 *
 * Wire-code contract — every tag in this file maps to a specific
 * `code` string via `worker/fate/errors.ts::encodeFateError`:
 *
 *   pasaport/UsernameInvalid       → INVALID_FORMAT | TOO_SHORT | TOO_LONG
 *   pasaport/UsernameTaken         → TAKEN
 *   pasaport/UsernameAlreadySet    → ALREADY_SET
 *   pasaport/UserNotFound          → USER_NOT_FOUND
 *
 * `Unauthorized` is reused from `worker/features/pasaport/Auth.ts` and is not
 * redeclared here — `Auth.required` is the single source of truth for the
 * unauthorized wire code.
 */
import {Data} from "effect";

/**
 * Sub-codes for username validation failures. They mirror the legacy
 * `UsernameValidationError.code` values so the wire format is preserved.
 */
export type UsernameInvalidCode = "invalid_format" | "too_short" | "too_long";

export class UsernameInvalid extends Data.TaggedError("pasaport/UsernameInvalid")<{
	readonly code: UsernameInvalidCode;
	readonly message: string;
}> {}

export class UsernameTaken extends Data.TaggedError("pasaport/UsernameTaken")<{
	readonly message: string;
}> {}

export class UsernameAlreadySet extends Data.TaggedError("pasaport/UsernameAlreadySet")<{
	readonly message: string;
}> {}

export class UserNotFound extends Data.TaggedError("pasaport/UserNotFound")<{
	readonly message: string;
}> {}
