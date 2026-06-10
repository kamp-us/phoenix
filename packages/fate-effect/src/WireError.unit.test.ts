/**
 * T0 — the `fateWireCode` annotation key and the wire-error codec.
 *
 * The contract under test (PRD: "define a domain error once with a
 * `fateWireCode` annotation on the error class and have the wire codec
 * derived from it — one edit instead of three"):
 *
 *   1. Annotating a `Schema.TaggedErrorClass` with `fateWireCode` is
 *      *sufficient* for {@link encodeWireError} to produce the correct wire
 *      code + message. No registry, no second edit.
 *   2. Un-annotated errors and defects (arbitrary thrown values) map to the
 *      internal-error wire code without throwing — and without leaking the
 *      original value's details onto the wire.
 *   3. The enumeration suite at the bottom pins every error-class ↔ wire-code
 *      pair the package ships, so silent codec drift is impossible: shipping a
 *      new annotated class (or changing a code) fails the pin until the table
 *      row is updated.
 */
import {FateRequestError} from "@nkzw/fate/server";
import * as Schema from "effect/Schema";
import {describe, expect, expectTypeOf, it} from "vitest";
import * as FateEffect from "./index.ts";
import {
	encodeWireError,
	fateWireCode,
	INTERNAL_WIRE_CODE,
	wireCodeOf,
	wireCodeOfClass,
} from "./WireError.ts";

/** A representative annotated domain error — the one-edit authoring shape. */
class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()(
	"test/BodyRequired",
	{message: Schema.String},
	{[fateWireCode]: "BODY_REQUIRED"},
) {}

/** An annotated error with extra fields beyond `message`. */
class DefinitionNotFound extends Schema.TaggedErrorClass<DefinitionNotFound>()(
	"test/DefinitionNotFound",
	{definitionId: Schema.String, message: Schema.String},
	{[fateWireCode]: "DEFINITION_NOT_FOUND"},
) {}

/** A tagged error WITHOUT the annotation — must fall back to internal. */
class Unannotated extends Schema.TaggedErrorClass<Unannotated>()("test/Unannotated", {
	message: Schema.String,
}) {}

describe("fateWireCode annotation", () => {
	it("is readable off the class", () => {
		expect(wireCodeOfClass(BodyRequired)).toBe("BODY_REQUIRED");
		expect(wireCodeOfClass(DefinitionNotFound)).toBe("DEFINITION_NOT_FOUND");
	});

	it("is readable off an instance", () => {
		expect(wireCodeOf(new BodyRequired({message: "tanım boş olamaz"}))).toBe("BODY_REQUIRED");
	});

	it("is absent on un-annotated classes and non-classes", () => {
		expect(wireCodeOfClass(Unannotated)).toBeUndefined();
		expect(wireCodeOf(new Unannotated({message: "x"}))).toBeUndefined();
		expect(wireCodeOfClass(undefined)).toBeUndefined();
		expect(wireCodeOfClass("BODY_REQUIRED")).toBeUndefined();
		expect(wireCodeOfClass(() => {})).toBeUndefined();
		expect(wireCodeOf(null)).toBeUndefined();
		expect(wireCodeOf(42)).toBeUndefined();
	});

	it("is typed `string | undefined` through the Schema.Annotations augmentation", () => {
		const annotations = Schema.resolveAnnotations(BodyRequired);
		expectTypeOf(annotations?.[fateWireCode]).toEqualTypeOf<string | undefined>();
	});
});

describe("encodeWireError", () => {
	it("round-trips an annotated error: annotation alone yields code + message", () => {
		const wire = encodeWireError(new BodyRequired({message: "tanım boş olamaz"}));
		expect(wire).toBeInstanceOf(FateRequestError);
		expect(wire.code).toBe("BODY_REQUIRED");
		expect(wire.message).toBe("tanım boş olamaz");
	});

	it("carries the instance message of each annotated error", () => {
		const wire = encodeWireError(
			new DefinitionNotFound({definitionId: "d1", message: "definition not found"}),
		);
		expect(wire.code).toBe("DEFINITION_NOT_FOUND");
		expect(wire.message).toBe("definition not found");
	});

	it("maps an un-annotated tagged error to the internal-error code without leaking details", () => {
		const wire = encodeWireError(new Unannotated({message: "secret internal detail"}));
		expect(wire).toBeInstanceOf(FateRequestError);
		expect(wire.code).toBe(INTERNAL_WIRE_CODE);
		expect(wire.message).not.toContain("secret internal detail");
	});

	it("maps defects to the internal-error code without throwing", () => {
		const defects: ReadonlyArray<unknown> = [
			new TypeError("cannot read properties of undefined"),
			new Error("boom"),
			"a thrown string",
			42,
			null,
			undefined,
			{some: "object"},
			Symbol("defect"),
		];
		for (const defect of defects) {
			const wire = encodeWireError(defect);
			expect(wire).toBeInstanceOf(FateRequestError);
			expect(wire.code).toBe(INTERNAL_WIRE_CODE);
		}
	});

	it("does not leak defect details onto the wire", () => {
		const wire = encodeWireError(new Error("D1_ERROR: no such table: users"));
		expect(wire.message).not.toContain("D1_ERROR");
		expect(wire.message).not.toContain("users");
	});

	it("passes an existing FateRequestError through verbatim", () => {
		const original = new FateRequestError("NOT_FOUND", "x");
		expect(encodeWireError(original)).toBe(original);
	});
});

describe("shipped error-class ↔ wire-code pairs", () => {
	/**
	 * The pin: every annotated error class exported from the package barrel,
	 * as `identifier → wire code`. The package ships none today — domain
	 * errors live in phoenix's features and annotate themselves. When a
	 * future task ships a package-owned annotated error (e.g. an input
	 * validation error), discovery below finds it and this literal must gain
	 * the row — silent codec drift is a test failure, not a runtime surprise.
	 */
	const SHIPPED_PAIRS: Readonly<Record<string, string>> = {};

	/**
	 * Discover every annotated error class reachable from the barrel —
	 * including through namespace exports (`export * as Fate`), which are
	 * plain objects: discovery recurses into object values so an error class
	 * shipped under a namespace cannot dodge the pin.
	 */
	const discover = (exports: Record<string, unknown>): Record<string, string> => {
		const found: Record<string, string> = {};
		const seen = new Set<unknown>();
		const visit = (value: unknown): void => {
			const code = wireCodeOfClass(value);
			if (code !== undefined && typeof value === "function") {
				const identifier =
					"identifier" in value && typeof value.identifier === "string"
						? value.identifier
						: value.name;
				found[identifier] = code;
				return;
			}
			if (typeof value === "object" && value !== null && !seen.has(value)) {
				seen.add(value);
				for (const nested of Object.values(value)) {
					visit(nested);
				}
			}
		};
		for (const value of Object.values(exports)) {
			visit(value);
		}
		return found;
	};

	it("the barrel ships exactly the pinned pairs", () => {
		expect(discover({...FateEffect})).toEqual(SHIPPED_PAIRS);
	});

	it("discovery would catch a shipped annotated class (the guard guards)", () => {
		const found = discover({BodyRequired, DefinitionNotFound, Unannotated, encodeWireError});
		expect(found).toEqual({
			"test/BodyRequired": "BODY_REQUIRED",
			"test/DefinitionNotFound": "DEFINITION_NOT_FOUND",
		});
	});

	it("discovery recurses into namespace exports (the guard guards, nested)", () => {
		const found = discover({Nested: {BodyRequired, deeper: {DefinitionNotFound}}});
		expect(found).toEqual({
			"test/BodyRequired": "BODY_REQUIRED",
			"test/DefinitionNotFound": "DEFINITION_NOT_FOUND",
		});
	});
});
