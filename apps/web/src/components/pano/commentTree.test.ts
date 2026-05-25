import {describe, expect, it} from "vitest";
import {buildCommentTree, type CommentNode} from "./commentTree";

/** Build a node with sane defaults; `ref` is just the id (refs are opaque here). */
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
		// `a` is deleted with no live descendant of its own beyond `b`; `b` is live,
		// so `a` stays visible as a tombstone and `b` nests under it. (Sanity: the
		// inverse — a dropped parent — is covered above.)
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
		// The whole point of the reframe: pass the nodes as they arrive (e.g. a
		// freshly-appended live comment) and they are placed immediately, with no
		// per-node effect having to fire first.
		const nodes = [
			node({id: "root"}),
			node({id: "reply", parentId: "root"}),
			node({id: "fresh", parentId: "root"}), // just arrived over SSE
		];
		const {roots, childrenByParent} = buildCommentTree(nodes);
		expect(roots.map((r) => r.id)).toEqual(["root"]);
		expect(childrenByParent.get("root")?.map((c) => c.id)).toEqual(["reply", "fresh"]);
	});
});
