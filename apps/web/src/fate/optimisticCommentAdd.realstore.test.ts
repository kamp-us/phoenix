/**
 * Real-store regression for optimistic `comment.add` reconciliation (#1714, ADR
 * 0125 A1). The shipped unit test (`optimisticCommentAdd.test.ts`) drives a FAKE
 * `CommentListStore` with literal `"temp"` ids, so an id-FORMAT mismatch between the
 * optimistic append and fate's reconcile paths cannot bite — which is exactly why
 * #1714 (a BARE `optimistic:<ts>` appended into a `toEntityId`-qualified list) shipped
 * uncaught. This suite closes that gap by driving the REAL `@nkzw/fate` `Store` (via a
 * minimal `FateClient`) through the reconcile seam the ADR's no-divergence guarantee
 * rests on: the mutation HTTP result — `client.resolveOptimisticEntity(tempId,
 * serverId)`, which rewrites the temp id in every backing list
 * (`store.replaceListEntityId`).
 *
 * Grounding for the qualified-id claim (verified against `@nkzw/fate@1.3.1`
 * `lib/index.mjs`): `writeEntity` returns `toEntityId(type, getId(record))` and both
 * the load and the SSE `insertConnectionEdge` path store that qualified id in
 * `list.ids`; `replaceListEntityId(previousId, …)` rewrites only when
 * `list.ids.includes(previousId)`, and the mutation callsite invokes it with the
 * qualified `toEntityId(entity, optimisticRecordId)` (index.mjs L820/842); the SSE
 * append dedups by canonical id `toEntityId(nodeType, id)`. So the list stores
 * `Comment:<id>` and both reconcile paths compare against `Comment:<id>` — a bare temp
 * id reconciles to neither.
 *
 * The live SSE `appendNode` dedup is `FateClient.insertConnectionEdge` — a PRIVATE
 * method (untypable from a test). It collapses a redundant append by canonical id:
 * an id already in `list.ids` short-circuits. We model that collapse at the public
 * seam via the production `appendOptimisticEdge`, whose idempotency is the same
 * canonical-id rule (an already-present id returns the list unchanged).
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

/**
 * A minimal real `FateClient` — enough to exercise the real `Store` + the public
 * `resolveOptimisticEntity` reconcile against fate's actual store, without a live
 * transport. No query/mutation/list resolvers are called by this test's paths, so the
 * transport is a never-invoked stub.
 */
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

/** The store slice `beginOptimisticCommentMembership` drives (the real `client.store` satisfies it). */
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

/** A fate connection carrying the `ConnectionTag` metadata key `connectionKey` reads. */
function connectionFor(key: string): unknown {
	return {[ConnectionTag]: {key}};
}

/** Seed a qualified `Post.comments` list — the runtime shape fate loads (`toEntityId`-qualified). */
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

		// The live SSE frame appendNode(serverId) dedups by canonical id — modelled here
		// by the production idempotent append (fate's private insertConnectionEdge uses the
		// same canonical-id short-circuit). The already-present server id collapses.
		const after = appendOptimisticEdge(client.store.getListState(CONNECTION_KEY), serverId);
		client.store.setList(CONNECTION_KEY, after);

		const ids = client.store.getListState(CONNECTION_KEY)?.ids ?? [];
		expect(ids).toEqual([serverId]);
		expect(ids.filter((id) => id === serverId)).toHaveLength(1);
	});

	// The regression: the SHIPPED bug — appending a BARE `optimistic:<ts>` — leaves a
	// non-reconciling, duplicated temp node. This is what the fake-store test could not
	// catch (#1714) and is the exact failure the qualified fix at the call site prevents.
	it("BARE temp id fails to reconcile — the #1714 defect, now guarded against", () => {
		const client = realClient();
		seedQualifiedList(client, []);

		const record = optimisticCommentRecord({
			postId: POST_ID,
			parentId: null,
			body: "merhaba",
			author: "umut",
			authorId: "user_1",
			now,
		});
		// The pre-fix id: the bare record id, NOT toEntityId-qualified.
		const bareTempId = record.id as EntityId;
		const serverId = toEntityId("Comment", "comm_server");
		beginOptimisticCommentMembership(
			membershipStore(client),
			connectionFor(CONNECTION_KEY),
			POST_ID,
			bareTempId,
		);

		// HTTP result reconcile is invoked with the QUALIFIED previousId (as the mutation
		// callsite does) — it does not match the bare stored id, so nothing is rewritten.
		client.resolveOptimisticEntity(toEntityId("Comment", record.id), serverId);
		// The live appendNode(serverId) keys off the qualified id — it does not dedup the
		// bare temp, so it lands as a SECOND edge.
		const after = appendOptimisticEdge(client.store.getListState(CONNECTION_KEY), serverId);
		client.store.setList(CONNECTION_KEY, after);

		const ids = client.store.getListState(CONNECTION_KEY)?.ids ?? [];
		expect(ids).toContain(bareTempId);
		expect(ids).toContain(serverId);
		expect(ids).toHaveLength(2);
	});
});
