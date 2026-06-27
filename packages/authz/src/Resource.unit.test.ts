/** Unit — `Resource` ancestry + covers (the relation-scope reach). */
import {describe, expect, it} from "vitest";
import {ancestry, covers, resource, sameNode} from "./Resource.ts";

const platform = resource("platform", "kampus");
const board = resource("board", "sozluk", platform);
const term = resource("term", "42", board);

describe("Resource", () => {
	it("sameNode compares (type, id), ignoring parent", () => {
		expect(sameNode(platform, resource("platform", "kampus", board))).toBe(true);
		expect(sameNode(platform, board)).toBe(false);
	});

	it("ancestry walks self → root, self first", () => {
		expect(ancestry(term).map((r) => `${r.type}:${r.id}`)).toEqual([
			"term:42",
			"board:sozluk",
			"platform:kampus",
		]);
		expect(ancestry(platform).map((r) => r.id)).toEqual(["kampus"]);
	});

	it("covers is reflexive and holds up the chain, never down", () => {
		expect(covers(term, term)).toBe(true); // reflexive
		expect(covers(platform, term)).toBe(true); // ancestor covers descendant
		expect(covers(board, term)).toBe(true);
		expect(covers(term, platform)).toBe(false); // descendant never covers ancestor
		expect(covers(resource("board", "pano"), term)).toBe(false); // unrelated
	});
});
