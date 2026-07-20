/**
 * Optimistic `definition.add` — the A1 client-append for the *nested*
 * `Term.definitions` connection (ADR
 * [0125](../../../../.decisions/0125-optimistic-reconciliation-live-driven-nested-connections.md),
 * #1679, epic #1637). `Term.definitions` is carried on the `term` query, never a
 * registered root list, so fate's declarative `insert`/`optimistic` membership
 * can't reach it (`registerRootList` is gated on `!filterConnectionArgs`). The
 * optimistic node is instead injected by this phoenix client helper, which drives
 * the same list state `insertConnectionEdge` mutates from the SSE `appendNode`.
 *
 * Two pieces, both hook-free so the branch predicate + the temp-node shape are
 * unit-testable apart from fate/React (the pure-core idiom of `postSubmitMembership`
 * / `bodyEditOptimistic`):
 *
 * - {@link buildOptimisticDefinition} builds the temp-id optimistic record (or
 *   `undefined` on the fresh-slug branch), mirroring the server's fresh-write
 *   initial state (`score: 0`, `myVote: null`, `updatedAt === createdAt`) so the
 *   reconciled server node can't diverge from the optimistic one (no phantom
 *   self-upvote, no false "düzenlendi").
 * - {@link appendOptimisticDefinitionEdge} appends the temp entity id to the nested
 *   connection's list state and returns a rollback that restores the pre-insert
 *   snapshot. On the mutation HTTP result fate's `resolveOptimisticEntity` rewrites
 *   the temp id to the server id across list states — so any server `appendNode`
 *   (before or after) dedups by **canonical entity id** and temp-node + server-append
 *   collapse to one edge. The caller rolls back on a rejected add.
 *
 * See `.patterns/fate-mutations-client.md` (§Optimistic nested-connection membership).
 */
import type {EntityId, List, Snapshot} from "@nkzw/fate";

/** Injectable now-clock so the optimistic `createdAt`/temp id are deterministic in tests. */
export type Now = () => Date;

const defaultNow: Now = () => new Date();

/** The already-derived author values the optimistic node mirrors. */
export interface OptimisticDefinitionInput {
	/** The submitted definition body. */
	readonly body: string;
	/** Display name for the author (name, falling back to email). */
	readonly author: string;
	/** The author's user id — drives `DefinitionCard`'s is-author edit/delete affordances. */
	readonly authorId: string;
}

/**
 * The optimistic `Definition` record, temp-id'd. Carries exactly the
 * `DefinitionView` fields so `useLiveView(DefinitionView, …)` reads it without a
 * missing-field suspend; fate reconciles it to the server node on the HTTP result.
 */
export interface OptimisticDefinition {
	readonly id: string;
	readonly body: string;
	readonly score: number;
	readonly myVote: null;
	readonly createdAt: Date;
	readonly updatedAt: Date;
	readonly author: string;
	readonly authorId: string;
}

/**
 * The optimistic definition record, or `undefined` when `enabled` is false — the
 * fresh-slug branch, which has no loaded definitions list to append to and drives
 * its own force-refetch + remount instead. `undefined` lets the call site spread it
 * away under `exactOptionalPropertyTypes` (`...(optimistic ? {optimistic} : {})`),
 * mirroring {@link bodyEditOptimistic}.
 *
 * Mirrors the server's fresh write (`definition.add` shapes `score` from a 0-vote
 * insert with `myVote: null`) so the optimistic node and the reconciled server node
 * hold the same fields — no phantom self-upvote (#707), and `updatedAt === createdAt`
 * so `EditedIndicator` shows no false "düzenlendi".
 */
export function buildOptimisticDefinition(
	enabled: boolean,
	input: OptimisticDefinitionInput,
	now: Now = defaultNow,
): OptimisticDefinition | undefined {
	if (!enabled) return undefined;
	const at = now();
	return {
		id: `optimistic:${at.getTime()}`,
		body: input.body,
		score: 0,
		myVote: null,
		createdAt: at,
		updatedAt: at,
		author: input.author,
		authorId: input.authorId,
	};
}

/**
 * The narrow slice of fate's `Store` the edge-injector needs — the three public
 * list methods — so the injector is unit-testable against a fake without a live
 * `FateClient`. `fate.store` satisfies it structurally.
 */
export interface DefinitionListStore {
	getListsForField(ownerId: string, field: string): ReadonlyArray<readonly [string, List]>;
	setList(key: string, state: List): void;
	restoreList(key: string, state?: List): void;
}

/**
 * The add path additionally bumps the term's aggregate count scalars, so it needs
 * the record `read`/`merge`/`snapshot`/`restore` methods on top of the list slice.
 * Kept separate from {@link DefinitionListStore} so the delete path (edge-drop only)
 * stays on the narrower interface. `fate.store` satisfies it structurally.
 */
export interface DefinitionAddStore extends DefinitionListStore {
	read(id: EntityId): Record<string, unknown> | undefined;
	merge(id: EntityId, partial: Record<string, unknown>, paths: Iterable<string>): void;
	snapshot(id: EntityId): Snapshot;
	restore(id: EntityId, snapshot: Snapshot): void;
}

/**
 * Append `optimisticEntityId` (a `Definition` **entity id**, e.g.
 * `Definition:optimistic:<ts>`) to every list state backing the term's nested
 * `definitions` connection, and return a rollback that restores each list to its
 * pre-insert snapshot.
 *
 * Appends to the visible window's tail: a fresh definition is `score: 0`, and
 * `DEFINITION_ORDERING` is score-desc then createdAt-asc, so a score-0 newest node
 * sorts to the bottom — the same slot the server `appendNode` targets. The temp id
 * is what fate's `resolveOptimisticEntity` rewrites to the server id on the HTTP
 * result, after which a server `appendNode(serverId)` dedups by canonical id
 * (`removeEntityFromListState` / visible short-circuit) — one edge, no double.
 *
 * Also bumps the term's aggregate definition-count scalars by one so the header
 * (`Term.count`, `SozlukTermHeader`) and the index row (`Term.definitionCount`,
 * `TermRow`/`SozlukHome`) agree with the rendered list during the optimistic window —
 * `definition.add` returns a `Definition`, not the parent `Term`, so nothing else
 * reconciles the aggregate until a refetch (#2198). Both scalars mirror the same
 * server `definitionCount` column (`term-fields.ts`), so each present one is bumped to
 * keep the two surfaces consistent (AC3). The bump rolls back with the list edge.
 *
 * A no-op (empty rollback) when the term has no loaded `definitions` list yet (the
 * fresh-slug branch, where there's nothing to append to) — that flow is driven by
 * the composer's force-refetch + remount, untouched here.
 */
export function appendOptimisticDefinitionEdge(
	store: DefinitionAddStore,
	termEntityId: EntityId,
	optimisticEntityId: EntityId,
): () => void {
	const rollbacks: Array<() => void> = [];
	const snapshots = store.getListsForField(termEntityId, "definitions");
	for (const [key, list] of snapshots) {
		const next: List = list.cursors
			? {...list, ids: [...list.ids, optimisticEntityId], cursors: [...list.cursors, undefined]}
			: {...list, ids: [...list.ids, optimisticEntityId]};
		store.setList(key, next);
		rollbacks.push(() => store.restoreList(key, list));
	}

	const term = store.read(termEntityId);
	if (term) {
		const partial: Record<string, unknown> = {};
		const paths: string[] = [];
		if (typeof term.count === "number") {
			partial.count = term.count + 1;
			paths.push("count");
		}
		if (typeof term.definitionCount === "number") {
			partial.definitionCount = term.definitionCount + 1;
			paths.push("definitionCount");
		}
		if (paths.length > 0) {
			const before = store.snapshot(termEntityId);
			store.merge(termEntityId, partial, paths);
			rollbacks.push(() => store.restore(termEntityId, before));
		}
	}

	return () => {
		for (const rollback of rollbacks.reverse()) rollback();
	};
}
