/**
 * The optimistic `post.delete` reconcile core (#1677, epic #1637 Class B) — the one
 * post-delete flow rule asserted without a DOM (the pure-extraction idiom of
 * `savedReconcile` / `useToggleAction`'s `nextToggleAction`).
 *
 * The pano feed is a registered root list, so fate's `delete: true` evicts the post
 * from it **synchronously** (before the round-trip) and rolls the eviction back
 * before a boundary throw (see `.patterns/fate-mutations-client.md`). This core
 * decides only what the call site does *after* the mutation promise settles: on
 * success stay on the feed (the row is already gone, the server `feed.deleteEdge`
 * frame reconciles it away for good); on `UNAUTHORIZED` re-auth; on any other
 * failure the post is already restored, so return to it and surface the existing
 * inline error.
 */
import type {FateWireCode} from "../lib/fateWireCodes";

/** The terminal outcome of an optimistic post-delete, decided off the wire code. */
export type OptimisticDeleteOutcome =
	/** Committed — the feed eviction stands; stay where the optimistic navigation landed. */
	| {readonly kind: "deleted"}
	/** `UNAUTHORIZED` — the session lapsed; route through the auth redirect. */
	| {readonly kind: "auth-redirect"}
	/** Rejected — fate restored the post; return to it and show the inline error. */
	| {readonly kind: "restore"; readonly code: FateWireCode};

/**
 * Classify the terminal state of an optimistic `post.delete` from its failure code
 * (`null` ⇒ the mutation resolved cleanly). `UNAUTHORIZED` routes to re-auth; every
 * other code means the write was rejected and fate already rolled the eviction back,
 * so the post is back in the feed and the call site returns to it with the code's
 * inline message.
 */
export function decideOptimisticDelete(failureCode: FateWireCode | null): OptimisticDeleteOutcome {
	if (failureCode == null) return {kind: "deleted"};
	if (failureCode === "UNAUTHORIZED") return {kind: "auth-redirect"};
	return {kind: "restore", code: failureCode};
}
