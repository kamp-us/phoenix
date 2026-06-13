import {describe, expect, it} from "vitest";
import {buildCommentTree, type CommentNode} from "./commentTree";

function node(over: Partial<CommentNode<string>> & {id: string}): CommentNode<string> {
	return {
		parentId: null,
		deletedAt: null,
		body: `body-${over.id}`,
		ref: over.id,
		...over,
	};
}

describe("buildCommentTree", () => {
	it("places top-level comments as roots in connection order", () => {
		const {roots, childrenByParent} = buildCommentTree([node({id: "a"}), node({id: "b"})]);
		expect(roots.map((r) => r.id)).toEqual(["a", "b"]);
		expect(childrenByParent.size).toBe(0);
	});

	it("nests a reply under its parent", () => {
		const {roots, childrenByParent} = buildCommentTree([
			node({id: "a"}),
			node({id: "b", parentId: "a"}),
		]);
		expect(roots.map((r) => r.id)).toEqual(["a"]);
		expect(childrenByParent.get("a")?.map((c) => c.id)).toEqual(["b"]);
	});

	it("nests deep (grandchildren) without re-walking", () => {
		const {roots, childrenByParent} = buildCommentTree([
			node({id: "a"}),
			node({id: "b", parentId: "a"}),
			node({id: "c", parentId: "b"}),
		]);
		expect(roots.map((r) => r.id)).toEqual(["a"]);
		expect(childrenByParent.get("a")?.map((c) => c.id)).toEqual(["b"]);
		expect(childrenByParent.get("b")?.map((c) => c.id)).toEqual(["c"]);
	});

	it("drops a soft-deleted leaf", () => {
		const {roots, childrenByParent, visibleCount} = buildCommentTree([
			node({id: "a"}),
			node({id: "b", parentId: "a", deletedAt: "2026-01-01T00:00:00Z"}),
		]);
		expect(roots.map((r) => r.id)).toEqual(["a"]);
		expect(childrenByParent.has("a")).toBe(false);
		expect(visibleCount).toBe(1);
	});

	it("keeps a soft-deleted parent as a tombstone when it has a live descendant", () => {
		const {roots, childrenByParent, visibleCount} = buildCommentTree([
			node({id: "a", deletedAt: "2026-01-01T00:00:00Z"}),
			node({id: "b", parentId: "a"}),
		]);
		expect(roots.map((r) => r.id)).toEqual(["a"]);
		expect(childrenByParent.get("a")?.map((c) => c.id)).toEqual(["b"]);
		expect(visibleCount).toBe(2);
	});

	it("keeps a deleted chain alive up to a live leaf (transitive visibility)", () => {
		const deleted = {deletedAt: "2026-01-01T00:00:00Z"};
		const {roots, childrenByParent, visibleCount} = buildCommentTree([
			node({id: "a", ...deleted}),
			node({id: "b", parentId: "a", ...deleted}),
			node({id: "c", parentId: "b"}),
		]);
		expect(roots.map((r) => r.id)).toEqual(["a"]);
		expect(childrenByParent.get("a")?.map((c) => c.id)).toEqual(["b"]);
		expect(childrenByParent.get("b")?.map((c) => c.id)).toEqual(["c"]);
		expect(visibleCount).toBe(3);
	});

	it("promotes a child whose parent is fully gone (not in the page) to a root", () => {
		const {roots, childrenByParent} = buildCommentTree([node({id: "b", parentId: "missing"})]);
		expect(roots.map((r) => r.id)).toEqual(["b"]);
		expect(childrenByParent.size).toBe(0);
	});

	it("promotes a child whose parent is soft-deleted-and-dropped to a root", () => {
		const {roots} = buildCommentTree([
			node({id: "a", deletedAt: "2026-01-01T00:00:00Z"}),
			node({id: "b", parentId: "a"}),
		]);
		expect(roots.map((r) => r.id)).toEqual(["a"]);
	});

	it("includes every node's body in bodyById regardless of visibility", () => {
		const {bodyById} = buildCommentTree([
			node({id: "a", body: "hello"}),
			node({id: "b", parentId: "a", deletedAt: "2026-01-01T00:00:00Z", body: "bye"}),
		]);
		expect(bodyById.get("a")).toBe("hello");
		expect(bodyById.get("b")).toBe("bye");
	});

	it("derives the full tree in one pass — no node is dropped for a missing-meta frame", () => {
		const nodes = [
			node({id: "root"}),
			node({id: "reply", parentId: "root"}),
			node({id: "fresh", parentId: "root"}),
		];
		const {roots, childrenByParent} = buildCommentTree(nodes);
		expect(roots.map((r) => r.id)).toEqual(["root"]);
		expect(childrenByParent.get("root")?.map((c) => c.id)).toEqual(["reply", "fresh"]);
	});
});
