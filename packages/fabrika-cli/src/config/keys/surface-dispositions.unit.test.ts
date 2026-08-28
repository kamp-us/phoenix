import {describe, expect, it} from "vitest";
import {loadConfig, resolve} from "../load.ts";
import {
	SHIPPED_SURFACE_DISPOSITIONS,
	SURFACE_REGISTRY,
	surfaceDispositionsKey,
} from "./surface-dispositions.ts";

const declared = (text: string) =>
	resolve(loadConfig({_tag: "Text", text}), surfaceDispositionsKey);

describe("the four resolution arms", () => {
	it("resolves an absent file to the shipped registry", () => {
		expect(resolve(loadConfig({_tag: "Absent"}), surfaceDispositionsKey)).toMatchObject({
			_tag: "Default",
			value: SHIPPED_SURFACE_DISPOSITIONS,
		});
	});

	it("resolves an absent key to the shipped registry", () => {
		expect(declared("{}")).toMatchObject({_tag: "Default", value: SHIPPED_SURFACE_DISPOSITIONS});
	});

	it("is UNKNOWN when the file could not be read, never the shipped registry", () => {
		expect(
			resolve(loadConfig({_tag: "Unreadable", reason: "EACCES"}), surfaceDispositionsKey),
		).toMatchObject({_tag: "Unknown"});
	});

	it("reads a declared disposition over the shipped one", () => {
		const resolved = declared('{"surfaceDispositions": {"design-manifest": "degrade"}}');
		expect(resolved).toMatchObject({_tag: "Declared"});
		expect(resolved._tag === "Declared" && resolved.value["design-manifest"]).toBe("degrade");
	});
});

describe("what a partial declaration leaves alone", () => {
	it("keeps every id the repo did not name at its shipped disposition", () => {
		const resolved = declared('{"surfaceDispositions": {"design-manifest": "degrade"}}');
		expect(resolved).toEqual({
			_tag: "Declared",
			value: {...SHIPPED_SURFACE_DISPOSITIONS, "design-manifest": "degrade"},
		});
	});
});

describe("what the key refuses whole", () => {
	/**
	 * A typo'd id is the failure this refusal exists for: silently ignored, it is a disposition the
	 * operator believes is configured and is not, and nothing anywhere would ever say so.
	 */
	it("refuses an id the registry does not know, naming it", () => {
		const resolved = declared('{"surfaceDispositions": {"desing-manifest": "degrade"}}');
		expect(resolved._tag).toBe("Malformed");
		expect(resolved._tag === "Malformed" && resolved.reason).toContain("desing-manifest");
	});

	it("refuses a disposition outside the closed vocabulary", () => {
		expect(declared('{"surfaceDispositions": {"design-manifest": "ignore"}}')).toMatchObject({
			_tag: "Malformed",
		});
	});

	it("refuses a value that is not an object", () => {
		expect(declared('{"surfaceDispositions": ["design-manifest"]}')).toMatchObject({
			_tag: "Malformed",
		});
	});
});

describe("the registry itself", () => {
	it("declares the optional authoritative source checkout and its refusal boundary", () => {
		const surface = SURFACE_REGISTRY.find(
			(candidate) => candidate.id === "authoritative-source-checkout",
		);
		expect(surface).toMatchObject({disposition: "degrade"});
		expect(surface?.note).toContain("exit 17");
	});

	it("carries one entry per id, with no duplicate", () => {
		const ids = SURFACE_REGISTRY.map((surface) => surface.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("says what every surface is, so no id is a bare slug", () => {
		for (const surface of SURFACE_REGISTRY) expect(surface.note.length).toBeGreaterThan(20);
	});
});
