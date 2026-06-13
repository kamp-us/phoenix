/**
 * Pins every pasaport error class to its wire `code`, so the annotation-derived
 * codec and the SPA's `MUTATION_ERROR_CODES` vocabulary can't drift
 * (`.patterns/fate-effect-wire-errors.md`).
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

const PASAPORT_WIRE_CODES = [
	[UsernameInvalidFormat, "INVALID_FORMAT"],
	[UsernameTooShort, "TOO_SHORT"],
	[UsernameTooLong, "TOO_LONG"],
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
