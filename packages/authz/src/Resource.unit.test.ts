/** Unit — `Resource` ancestry + covers (the relation-scope reach) + the `key` seam. */
import {describe, expect, it} from "vitest";
import {ancestry, covers, key, platform as platformRoot, resource, sameNode} from "./Resource.ts";

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

	it("key encodes a node as `type:id` — the one storage key both seam sides agree on", () => {
		expect(key(term)).toBe("term:42");
		expect(key(resource("post", "abc"))).toBe("post:abc");
		// key ignores the parent (only the node's own (type, id)), so an ancestor
		// and the same node reparented serialize identically.
		expect(key(platform)).toBe(key(resource("platform", "kampus", board)));
	});

	it("platform is the fixed singleton root — one stable key across mint and read", () => {
		expect(platformRoot.type).toBe("platform");
		expect(platformRoot.parent).toBeUndefined();
		expect(key(platformRoot)).toBe("platform:platform");
	});
});
