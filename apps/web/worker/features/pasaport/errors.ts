/**
 * Tagged errors raised by the Pasaport service layer.
 *
 * Wire-code contract — every class carries its wire `code` as a
 * `fateWireCode` annotation (`.patterns/fate-effect-wire-errors.md`), which
 * `encodeWireError` reads at the fate boundary:
 *
 *   pasaport/UsernameInvalidFormat → INVALID_FORMAT
 *   pasaport/UsernameTooShort      → TOO_SHORT
 *   pasaport/UsernameTooLong       → TOO_LONG
 *   pasaport/UsernameTaken         → TAKEN
 *   pasaport/UsernameAlreadySet    → ALREADY_SET
 *   pasaport/UserNotFound          → USER_NOT_FOUND
 *
 * The bridge-era `UsernameInvalid` class carried a dynamic `code` field the
 * registry upcased per instance (`too_short` → `TOO_SHORT`). `fateWireCode`
 * is one static code per class — the codec reads the instance's CONSTRUCTOR
 * annotation (`wireCodeOf`), so each sub-code is its own class and
 * {@link UsernameInvalid} survives as the union alias the `Pasaport` service
 * signatures name (the pano `PostValidation` split is the precedent — see
 * "One class, one code" in the wire-errors pattern doc). Wire codes preserved
 * verbatim (they match the bridge's retired `upcased`/`fixed` registry arms
 * exactly) so SPA pattern-matching keeps working unchanged;
 * `errors.unit.test.ts` pins each pair.
 *
 * The package's `Unauthorized` (annotated `UNAUTHORIZED`) gates the writes
 * via `CurrentUser.required` and is not redeclared here.
 */
import {fateWireCode} from "@phoenix/fate-effect";
import * as Schema from "effect/Schema";

/* -------------------------------------------------------------------------- */
/* Username validation (one class per bridge sub-code)                         */
/* -------------------------------------------------------------------------- */

/** The username contains characters outside the allowed lowercase set. */
export class UsernameInvalidFormat extends Schema.TaggedErrorClass<UsernameInvalidFormat>()(
	"pasaport/UsernameInvalidFormat",
	{message: Schema.String},
	{[fateWireCode]: "INVALID_FORMAT"},
) {}

/** The username is shorter than the 3-character minimum. */
export class UsernameTooShort extends Schema.TaggedErrorClass<UsernameTooShort>()(
	"pasaport/UsernameTooShort",
	{message: Schema.String},
	{[fateWireCode]: "TOO_SHORT"},
) {}

/** The username exceeds the 30-character maximum. */
export class UsernameTooLong extends Schema.TaggedErrorClass<UsernameTooLong>()(
	"pasaport/UsernameTooLong",
	{message: Schema.String},
	{[fateWireCode]: "TOO_LONG"},
) {}

/**
 * `setUsername` rejected its value — the union the `Pasaport` service
 * signatures declare. Replaces the bridge-era single `UsernameInvalid` class
 * (whose `code` field named the sub-code; see the module header).
 */
export type UsernameInvalid = UsernameInvalidFormat | UsernameTooShort | UsernameTooLong;

/**
 * The `UsernameInvalid` members as schema classes, in bridge-registry order —
 * spread into the mutation `error:` union so the declared set cannot drift
 * from the alias above.
 */
export const UsernameInvalidErrors = [
	UsernameInvalidFormat,
	UsernameTooShort,
	UsernameTooLong,
] as const;

/* -------------------------------------------------------------------------- */
/* Uniqueness / immutability / existence                                       */
/* -------------------------------------------------------------------------- */

/** The normalized username is already claimed by another user. */
export class UsernameTaken extends Schema.TaggedErrorClass<UsernameTaken>()(
	"pasaport/UsernameTaken",
	{
		message: Schema.String,
	},
	{[fateWireCode]: "TAKEN"},
) {}

/** The user already has a username — it is immutable once set. */
export class UsernameAlreadySet extends Schema.TaggedErrorClass<UsernameAlreadySet>()(
	"pasaport/UsernameAlreadySet",
	{
		message: Schema.String,
	},
	{[fateWireCode]: "ALREADY_SET"},
) {}

/** `setUsername` targeted a user id with no canonical user row. */
export class UserNotFound extends Schema.TaggedErrorClass<UserNotFound>()(
	"pasaport/UserNotFound",
	{
		message: Schema.String,
	},
	{[fateWireCode]: "USER_NOT_FOUND"},
) {}
