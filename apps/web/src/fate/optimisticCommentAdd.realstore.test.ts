/**
 * Real-store regression for optimistic `comment.add` reconciliation (#1714, ADR 0125
 * A1). The sibling unit test drives a FAKE store with literal `"temp"` ids, so an
 * id-FORMAT mismatch cannot bite there — which is exactly why #1714 shipped uncaught.
 * This one drives the REAL `@nkzw/fate` `Store`.
 *
 * Grounding for the qualified-id claim (verified against `@nkzw/fate@1.3.1`
 * `lib/index.mjs`): `writeEntity` returns `toEntityId(type, getId(record))`, and both
 * the load and the SSE `insertConnectionEdge` path store that qualified id in
 * `list.ids`; `replaceListEntityId` rewrites only when `list.ids.includes(previousId)`,
 * and the mutation callsite passes the qualified id (L820/842). A bare temp id
 * reconciles to neither path.
 *
 * The SSE dedup itself is `FateClient.insertConnectionEdge`, a PRIVATE method untypable
 * from a test, so its canonical-id short-circuit is modelled through the production
 * `appendOptimisticEdge`, which is idempotent by the same rule.
 */
import {ConnectionTag, createClient, type EntityId, type List, toEntityId} from "@nkzw/fate";
import {describe, expect, it} from "vitest";
import {
	appendOptimisticEdge,
	beginOptimisticCommentMembership,
	optimisticCommentRecord,
} from "./optimisticCommentAdd";

const POST_ID = "post_1";
const CONNECTION_KEY = `Post:${POST_ID}.comments`;
const now = new Date("2026-07-02T12:00:00.000Z");

/** No resolver is reached by this test's paths, so the transport is a never-invoked stub. */
function realClient() {
	return createClient({
		hydrationScope: "test",
		roots: {},
		types: [{type: "Post"}, {type: "Comment"}],
		transport: {
			fetchById: () => {
				throw new Error("transport unused in this test");
			},
			fetchList: () => {
				throw new Error("transport unused in this test");
			},
			fetchQuery: () => {
				throw new Error("transport unused in this test");
			},
			mutate: () => {
				throw new Error("transport unused in this test");
			},
		},
	});
}

function membershipStore(client: ReturnType<typeof realClient>) {
	const store = client.store;
	return {
		getListState: (key: string) => store.getListState(key),
		setList: (key: string, state: List) => store.setList(key, state),
		restoreList: (key: string, list?: List) => store.restoreList(key, list),
		read: (id: EntityId) => store.read(id),
		merge: (id: EntityId, partial: Record<string, unknown>, paths: Iterable<string>) =>
			store.merge(id, partial, paths),
		snapshot: (id: EntityId) => store.snapshot(id),
		restore: (id: EntityId, snapshot: ReturnType<typeof store.snapshot>) =>
			store.restore(id, snapshot),
	};
}

function connectionFor(key: string): unknown {
	return {[ConnectionTag]: {key}};
}

/** Seeds the `toEntityId`-qualified list shape fate loads at runtime. */
function seedQualifiedList(client: ReturnType<typeof realClient>, ids: ReadonlyArray<EntityId>) {
	client.store.setList(CONNECTION_KEY, {ids: [...ids]});
}

describe("optimistic comment.add — real-store reconciliation (#1714)", () => {
	it("appends a toEntityId-qualified temp id into the real Post.comments list", () => {
		const client = realClient();
		const existing = toEntityId("Comment", "comm_a");
		seedQualifiedList(client, [existing]);

		const record = optimisticCommentRecord({
			postId: POST_ID,
			parentId: null,
			body: "merhaba",
			author: "umut",
			authorId: "user_1",
			sandboxed: false,
			now,
		});
		const tempId = toEntityId("Comment", record.id);
		beginOptimisticCommentMembership(
			membershipStore(client),
			connectionFor(CONNECTION_KEY),
			POST_ID,
			tempId,
		);

		expect(client.store.getListState(CONNECTION_KEY)?.ids).toEqual([existing, tempId]);
	});

	it("reconciles the temp id to the server id on the HTTP result (no orphan temp)", () => {
		const client = realClient();
		seedQualifiedList(client, []);

		const record = optimisticCommentRecord({
			postId: POST_ID,
			parentId: null,
			body: "merhaba",
			author: "umut",
			authorId: "user_1",
			sandboxed: false,
			now,
		});
		const tempId = toEntityId("Comment", record.id);
		const serverId = toEntityId("Comment", "comm_server");
		beginOptimisticCommentMembership(
			membershipStore(client),
			connectionFor(CONNECTION_KEY),
			POST_ID,
			tempId,
		);

		client.resolveOptimisticEntity(tempId, serverId);

		const ids = client.store.getListState(CONNECTION_KEY)?.ids;
		expect(ids).toEqual([serverId]);
		expect(ids).not.toContain(tempId);
	});

	it("collapses a live appendNode against the reconciled id — one edge, no duplicate", () => {
		const client = realClient();
		seedQualifiedList(client, []);

		const record = optimisticCommentRecord({
			postId: POST_ID,
			parentId: null,
			body: "merhaba",
			author: "umut",
			authorId: "user_1",
			sandboxed: false,
			now,
		});
		const tempId = toEntityId("Comment", record.id);
		const serverId = toEntityId("Comment", "comm_server");
		beginOptimisticCommentMembership(
			membershipStore(client),
			connectionFor(CONNECTION_KEY),
			POST_ID,
			tempId,
		);
		client.resolveOptimisticEntity(tempId, serverId);

		// Models the SSE appendNode(serverId) dedup with the production idempotent append.
		const after = appendOptimisticEdge(client.store.getListState(CONNECTION_KEY), serverId);
		client.store.setList(CONNECTION_KEY, after);

		const ids = client.store.getListState(CONNECTION_KEY)?.ids ?? [];
		expect(ids).toEqual([serverId]);
		expect(ids.filter((id) => id === serverId)).toHaveLength(1);
	});

	// Reproduces the shipped #1714 bug on purpose: a BARE `optimistic:<ts>` reconciles to
	// nothing and duplicates. Deliberately wrong input, not a stale test.
	it("BARE temp id fails to reconcile — the #1714 defect, now guarded against", () => {
		const client = realClient();
		seedQualifiedList(client, []);

		const record = optimisticCommentRecord({
			postId: POST_ID,
			parentId: null,
			body: "merhaba",
			author: "umut",
			authorId: "user_1",
			sandboxed: false,
			now,
		});
		// The pre-fix id: bare, NOT toEntityId-qualified.
		const bareTempId = record.id as EntityId;
		const serverId = toEntityId("Comment", "comm_server");
		beginOptimisticCommentMembership(
			membershipStore(client),
			connectionFor(CONNECTION_KEY),
			POST_ID,
			bareTempId,
		);

		// Called with the QUALIFIED previousId, as the mutation callsite does.
		client.resolveOptimisticEntity(toEntityId("Comment", record.id), serverId);
		const after = appendOptimisticEdge(client.store.getListState(CONNECTION_KEY), serverId);
		client.store.setList(CONNECTION_KEY, after);

		const ids = client.store.getListState(CONNECTION_KEY)?.ids ?? [];
		expect(ids).toContain(bareTempId);
		expect(ids).toContain(serverId);
		expect(ids).toHaveLength(2);
	});
});
