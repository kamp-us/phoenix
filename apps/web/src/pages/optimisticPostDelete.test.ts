/**
 * The optimistic post-delete reconcile contract (#1677) — the terminal-outcome rule
 * asserted without a DOM (the pure-extraction idiom of `savedReconcile`). These are
 * the AC the optimistic flow lives or dies on: a clean resolve stays on the feed
 * (the row already left optimistically and the server `deleteEdge` reconciles it), a
 * lapsed session re-auths, and any rejection returns to the (now-restored) post with
 * the inline error code.
 */
import {describe, expect, it} from "vitest";
import {decideOptimisticDelete} from "./optimisticPostDelete";

describe("decideOptimisticDelete — the terminal post-delete rule", () => {
	it("a clean resolve (no failure code) stays deleted — the optimistic eviction stands", () => {
		expect(decideOptimisticDelete(null)).toEqual({kind: "deleted"});
	});

	it("UNAUTHORIZED routes to the auth redirect, not an inline error", () => {
		expect(decideOptimisticDelete("UNAUTHORIZED")).toEqual({kind: "auth-redirect"});
	});

	it("POST_DELETE_FAILED restores the post and carries the code for the inline error (#1639)", () => {
		expect(decideOptimisticDelete("POST_DELETE_FAILED")).toEqual({
			kind: "restore",
			code: "POST_DELETE_FAILED",
		});
	});

	it("any other rejection restores with its own code (fate already rolled the eviction back)", () => {
		expect(decideOptimisticDelete("POST_NOT_FOUND")).toEqual({
			kind: "restore",
			code: "POST_NOT_FOUND",
		});
		expect(decideOptimisticDelete("INTERNAL_SERVER_ERROR")).toEqual({
			kind: "restore",
			code: "INTERNAL_SERVER_ERROR",
		});
	});
});
