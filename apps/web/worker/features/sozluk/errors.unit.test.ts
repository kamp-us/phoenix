/**
 * Pins each sozluk error class to the exact wire code the retired bridge
 * registry emitted, so the annotation-derived codec and the SPA's
 * `MUTATION_ERROR_CODES` vocabulary can't drift. Re-annotating a class fails it.
 */
import {encodeWireError, wireCodeOfClass} from "@phoenix/fate-effect";
import {describe, expect, it} from "vitest";
import {
	BodyRequired,
	BodyTooLong,
	DefinitionNotFound,
	UnauthorizedDefinitionMutation,
} from "./errors.ts";

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
