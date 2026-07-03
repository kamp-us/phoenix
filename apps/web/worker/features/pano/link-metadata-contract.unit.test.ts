/**
 * The client-side safe-default parse of the `/api/pano/link-metadata` response
 * (#1642) — tested without a DOM, the same pure-core idiom as
 * `evaluate-contract.unit.test.ts`. `parseLinkMetadataResponse` is what
 * enforces "a flaky page can only ever leave the form untouched": a non-string,
 * empty, or absent field must parse to absent so it is never prefilled.
 */
import {describe, expect, it} from "vitest";
import {parseLinkMetadataResponse} from "./link-metadata-contract.ts";

describe("parseLinkMetadataResponse", () => {
	it("keeps genuine string fields", () => {
		expect(parseLinkMetadataResponse({title: "T", description: "D"})).toEqual({
			title: "T",
			description: "D",
		});
	});

	it("drops non-string fields", () => {
		expect(parseLinkMetadataResponse({title: 42, description: {}})).toEqual({});
	});

	it("drops empty/whitespace-only fields (never prefills blank)", () => {
		expect(parseLinkMetadataResponse({title: "   ", description: ""})).toEqual({});
	});

	it("returns {} for a non-object / null body (fetch-failure path)", () => {
		expect(parseLinkMetadataResponse(null)).toEqual({});
		expect(parseLinkMetadataResponse("nope")).toEqual({});
		expect(parseLinkMetadataResponse(undefined)).toEqual({});
	});

	it("keeps only the present field when the other is missing", () => {
		expect(parseLinkMetadataResponse({title: "only title"})).toEqual({title: "only title"});
	});
});
