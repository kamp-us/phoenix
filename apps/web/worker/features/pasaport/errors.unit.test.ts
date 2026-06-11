/**
 * Pasaport error-class ↔ wire-code enumeration pin (T0).
 *
 * The migrated pasaport records derive wire codes from the `ErrorCode`
 * annotation on each error class (`.patterns/fate-effect-wire-errors.md`) —
 * no registry. This pin is the app-side counterpart of the package's
 * `WireError.unit.test.ts` enumeration: every error class pasaport operations
 * can fail with, paired with the exact wire code the retired bridge's
 * `WIRE_CODE_BY_TAG` registry emitted for it (deleted in the v1 cutover), so the annotation-derived codec
 * and the SPA's `MUTATION_ERROR_CODES` vocabulary cannot drift through the
 * migration.
 *
 * The bridge's `pasaport/UsernameInvalid` carried a dynamic `code` field the
 * registry upcased per instance (`too_short` → `TOO_SHORT`); `ErrorCode`
 * is ONE static code per class (`wireCodeOf` reads the instance's
 * CONSTRUCTOR annotation), so each sub-code is now its own class — this
 * table pins every split class to the exact upcased code the `upcased`
 * registry arm produced for it (the pano split is the precedent).
 */
import {encodeWireError, wireCodeOfClass} from "@phoenix/fate-effect";
import {describe, expect, it} from "vitest";
import {
	UserNotFound,
	UsernameAlreadySet,
	UsernameInvalidFormat,
	UsernameTaken,
	UsernameTooLong,
	UsernameTooShort,
} from "./errors.ts";

/**
 * The pinned pairs — wire codes preserved verbatim from the bridge registry
 * (`WIRE_CODE_BY_TAG`, pasaport section — registry deleted in the v1 cutover: the
 * `fixed` arms plus every member of the `upcased` arm's declared set).
 */
const PASAPORT_WIRE_CODES = [
	// UsernameInvalid sub-codes (the bridge's `upcased` arm, one class each).
	[UsernameInvalidFormat, "INVALID_FORMAT"],
	[UsernameTooShort, "TOO_SHORT"],
	[UsernameTooLong, "TOO_LONG"],
	// Fixed arms.
	[UsernameTaken, "TAKEN"],
	[UsernameAlreadySet, "ALREADY_SET"],
	[UserNotFound, "USER_NOT_FOUND"],
] as const;

describe("pasaport wire-code annotations", () => {
	it.each(PASAPORT_WIRE_CODES)("%o carries its bridge wire code", (ctor, code) => {
		expect(wireCodeOfClass(ctor)).toBe(code);
	});

	it("an annotated instance encodes to its wire code with its own message", () => {
		const error = new UsernameTooShort({message: "kullanıcı adı en az 3 karakter olmalı"});
		const wire = encodeWireError(error);
		expect(wire.code).toBe("TOO_SHORT");
		expect(wire.message).toBe("kullanıcı adı en az 3 karakter olmalı");
	});
});
