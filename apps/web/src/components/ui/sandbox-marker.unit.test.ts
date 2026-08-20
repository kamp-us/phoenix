/**
 * The one-badge ruling (#6427, epic #4306): at most one sandbox badge per item, and on your
 * own item the owner's "incelemede" wins over the reader-facing çaylak marker. The overlap
 * row is not hypothetical — a çaylak promoted to yazar who opts in reads both fields true on
 * their own not-yet-promoted content.
 */
import {describe, expect, it} from "vitest";
import {sandboxMarker} from "./sandbox-marker";

describe("sandboxMarker (#6427)", () => {
	it("marks somebody else's hazırlık-stage item for the opted-in reader", () => {
		expect(sandboxMarker({isOwn: false, sandboxedInPlace: true})).toBe("caylak");
	});

	it("keeps the owner's incelemede badge on their own in-review item", () => {
		expect(sandboxMarker({isOwn: true, sandboxed: true})).toBe("review");
	});

	it("shows the owner's badge alone when both fields are true on one item", () => {
		expect(sandboxMarker({isOwn: true, sandboxed: true, sandboxedInPlace: true})).toBe("review");
	});

	it("never shows the reader-facing marker on an item you wrote", () => {
		expect(sandboxMarker({isOwn: true, sandboxed: false, sandboxedInPlace: true})).toBe("none");
	});

	it("shows nothing when the wire field is false", () => {
		expect(sandboxMarker({isOwn: false, sandboxed: false, sandboxedInPlace: false})).toBe("none");
	});

	// With PHOENIX_CAYLAK_VISIBILITY off the resolver never widens the viewer, so every read
	// carries the field false — and a surface that doesn't select it at all carries nothing.
	it("shows nothing for the flag-off wire shape, field false or absent", () => {
		expect(sandboxMarker({isOwn: false, sandboxedInPlace: false})).toBe("none");
		expect(sandboxMarker({isOwn: false})).toBe("none");
		expect(sandboxMarker({isOwn: false, sandboxedInPlace: null})).toBe("none");
	});

	it("shows nothing to a non-owner on an item with no sandbox state at all", () => {
		expect(sandboxMarker({isOwn: false, sandboxed: true})).toBe("none");
	});
});
