import {describe, expect, it} from "vitest";
import {
	composeToken,
	createBranchName,
	isKebabSlug,
	laneNumber,
	nonceOf,
	parseLaneBranch,
	parseToken,
	resumeBranchName,
} from "./lane.ts";

const UUID = "c1a4d6f8-3b7e-4a19-9c2d-5e8f0a1b2c3d";

describe("the token shape is pinned", () => {
	it("splits a well-formed token into its session and uuid halves", () => {
		expect(parseToken(`build:s-9f2e:${UUID}`)).toEqual({session: "s-9f2e", uuid: UUID});
	});

	it("refuses a token that is not this group's — a comment id is not a session id (#4428)", () => {
		expect(parseToken("512345")).toBeNull();
		expect(parseToken(`claim:s-9f2e:${UUID}`)).toBeNull();
	});

	it("derives the nonce from the uuid's first 8 hex, hyphens stripped", () => {
		expect(nonceOf(composeToken("s-9f2e", UUID))).toBe("c1a4d6f8");
	});

	it("yields no nonce from a token it cannot parse — never a truncated guess", () => {
		expect(nonceOf("build:s-9f2e")).toBeNull();
	});
});

describe("slug validation", () => {
	it("accepts kebab-case up to five words", () => {
		expect(isKebabSlug("editor-focus-loss")).toBe(true);
		expect(isKebabSlug("a-b-c-d-e")).toBe(true);
	});

	it("refuses a flag-shaped slug — the #4854 refusal", () => {
		expect(isKebabSlug("-rf")).toBe(false);
	});

	it("refuses six words, uppercase, and double hyphens", () => {
		expect(isKebabSlug("a-b-c-d-e-f")).toBe(false);
		expect(isKebabSlug("Editor-Focus")).toBe(false);
		expect(isKebabSlug("editor--focus")).toBe(false);
	});
});

describe("a lane branch parses back into its lane", () => {
	it("round-trips a create-mode branch", () => {
		const name = createBranchName(4312, "editor-focus-loss", "c1a4d6f8");
		expect(name).toBe("build/4312-editor-focus-loss-c1a4d6f8");
		const lane = parseLaneBranch(name);
		expect(lane).toEqual({
			_tag: "Create",
			number: 4312,
			slug: "editor-focus-loss",
			nonce: "c1a4d6f8",
		});
		expect(lane === null ? null : laneNumber(lane)).toBe(4312);
	});

	it("round-trips a resume-mode branch, and reads its number as the PR's", () => {
		const name = resumeBranchName(4310, "c1a4d6f8");
		expect(name).toBe("build/pr-4310-c1a4d6f8");
		const lane = parseLaneBranch(name);
		expect(lane?._tag).toBe("Resume");
		expect(lane === null ? null : laneNumber(lane)).toBe(4310);
	});

	it("reads a foreign branch as no lane at all, rather than as a lane with a missing nonce", () => {
		expect(parseLaneBranch("main")).toBeNull();
		expect(parseLaneBranch("build/4312-editor-focus-loss")).toBeNull();
		expect(parseLaneBranch("umut/editor-focus-loss-c1a4d6f8")).toBeNull();
	});
});
