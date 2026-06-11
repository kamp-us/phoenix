/**
 * Sozluk error-class ↔ wire-code enumeration pin (T0).
 *
 * The migrated sozluk records derive wire codes from the `WireCode`
 * annotation on each error class (`.patterns/fate-effect-wire-errors.md`) —
 * no registry. This pin is the app-side counterpart of the package's
 * `WireError.unit.test.ts` enumeration: every error class sozluk operations
 * can fail with, paired with the exact wire code the retired bridge's
 * `WIRE_CODE_BY_TAG` registry emitted for it (deleted in the v1 cutover), so the annotation-derived codec
 * and the SPA's `MUTATION_ERROR_CODES` vocabulary cannot drift through the
 * migration. Re-annotating (or un-annotating) a class fails this test.
 */
import {encodeWireError, wireCodeOfClass} from "@phoenix/fate-effect";
import {describe, expect, it} from "vitest";
import {
	BodyRequired,
	BodyTooLong,
	DefinitionNotFound,
	UnauthorizedDefinitionMutation,
} from "./errors.ts";

/**
 * The pinned pairs — wire codes preserved verbatim from the bridge registry
 * (`WIRE_CODE_BY_TAG`, sozluk section — registry deleted in the v1 cutover).
 */
const SOZLUK_WIRE_CODES = [
	[BodyRequired, "BODY_REQUIRED"],
	[BodyTooLong, "BODY_TOO_LONG"],
	[DefinitionNotFound, "DEFINITION_NOT_FOUND"],
	[UnauthorizedDefinitionMutation, "UNAUTHORIZED"],
] as const;

describe("sozluk wire-code annotations", () => {
	it.each(SOZLUK_WIRE_CODES)("%o carries its bridge wire code", (ctor, code) => {
		expect(wireCodeOfClass(ctor)).toBe(code);
	});

	it("an annotated instance encodes to its wire code with its own message", () => {
		const error = new BodyRequired({message: "tanım boş olamaz"});
		const wire = encodeWireError(error);
		expect(wire.code).toBe("BODY_REQUIRED");
		expect(wire.message).toBe("tanım boş olamaz");
	});
});
