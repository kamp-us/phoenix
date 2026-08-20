/**
 * Optimistic `definition.add` for the *nested* `Term.definitions` connection. fate's
 * declarative `insert`/`optimistic` membership cannot reach it — `registerRootList` is
 * gated on `!filterConnectionArgs`, and this connection is carried on the `term` query —
 * so the edge is injected here instead, into the same list state the SSE `appendNode`
 * mutates. See ADR
 * [0125](../../../../.decisions/0125-optimistic-reconciliation-live-driven-nested-connections.md)
 * and `.patterns/fate-mutations-client.md` (§Optimistic nested-connection membership).
 */
import type {EntityId, List, Snapshot} from "@nkzw/fate";

/** Injectable so the optimistic `createdAt` and temp id are deterministic in tests. */
export type Now = () => Date;

const defaultNow: Now = () => new Date();

export interface OptimisticDefinitionInput {
	readonly body: string;
	/** Display name for the author (name, falling back to email). */
	readonly author: string;
	readonly authorId: string;
}

/** Must carry exactly the `DefinitionView` fields, or `useLiveView` suspends on a missing one. */
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
 * The shape mirrors the server's fresh write exactly, so the reconciled node can't diverge:
 * `score: 0` with `myVote: null` (no phantom self-upvote, #707) and `updatedAt === createdAt`
 * (no false "düzenlendi"). `undefined` rather than null so the call site can spread it away
 * under `exactOptionalPropertyTypes`.
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

/** A narrow slice of fate's `Store` so the injector is testable against a fake. */
export interface DefinitionListStore {
	getListsForField(ownerId: string, field: string): ReadonlyArray<readonly [string, List]>;
	setList(key: string, state: List): void;
	restoreList(key: string, state?: List): void;
}

/** Kept apart from {@link DefinitionListStore} so the delete path stays on the narrower slice. */
export interface DefinitionAddStore extends DefinitionListStore {
	read(id: EntityId): Record<string, unknown> | undefined;
	merge(id: EntityId, partial: Record<string, unknown>, paths: Iterable<string>): void;
	snapshot(id: EntityId): Snapshot;
	restore(id: EntityId, snapshot: Snapshot): void;
}

/**
 * Appends to the tail, which is where the server `appendNode` lands too: a fresh definition
 * is `score: 0` and `DEFINITION_ORDERING` is score-desc then createdAt-asc. fate rewrites the
 * temp id to the server id on the HTTP result, so the later server append dedups by canonical
 * id — one edge, not two.
 *
 * Also bumps the term's two aggregate count scalars: `definition.add` returns a `Definition`,
 * not the parent `Term`, so nothing else reconciles them until a refetch (#2198).
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
