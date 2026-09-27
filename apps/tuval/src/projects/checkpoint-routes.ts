/**
 * The desk's one `Checkpoints`, sending each process to its project's store (#9685). A process runs
 * a project's row when its program id carries that project's scope (`../project-id.ts`), and its
 * checkpoint lands in that project's state directory. Every other process — the desk's, a global
 * program's, and one whose project has no route — checkpoints into the desk's store.
 *
 * Two routes may share one store: the boot project's state directory is the desk's, and one
 * directory has one manifest, so it has to have one writer.
 */

import {Checkpoints} from "@kampus/tuval-sdk/kernel/durability/Checkpoints";
import type {ManifestEntry} from "@kampus/tuval-sdk/kernel/durability/snapshot";
import {scopedIdParts} from "@kampus/tuval-sdk/kernel/registry/scoped-id";
import {Effect} from "effect";

type Store = Checkpoints["Service"];

export interface CheckpointRoutes {
	readonly checkpoints: Store;
	/** Send the processes of the project keyed `project` to `store` from now on. */
	readonly route: (project: string, store: Store) => Effect.Effect<void>;
	readonly unroute: (project: string) => Effect.Effect<void>;
}

export const checkpointRoutes = (desk: Store): CheckpointRoutes => {
	const routes = new Map<string, Store>();
	const storeOf = (programId: string): Store => {
		const {scope} = scopedIdParts(programId);
		return (scope === undefined ? undefined : routes.get(scope)) ?? desk;
	};
	/** Each store once, the desk's first. */
	const stores = (): ReadonlyArray<Store> => [...new Set([desk, ...routes.values()])];
	return {
		checkpoints: Checkpoints.of({
			open: (target) => Effect.suspend(() => storeOf(target.programId).open(target)),
			list: Effect.suspend(() =>
				Effect.map(
					// Serial so the list keeps the desk's entries first, then each project's in route order.
					Effect.forEach(stores(), (store) => store.list, {concurrency: 1}),
					(lists) => lists.flat(),
				),
			),
			// A process's subtree can straddle stores — a project's process under the desk's shell —
			// and forgetting an id a store does not hold is a no-op, so every store is asked.
			forget: (id) =>
				Effect.suspend(() =>
					Effect.forEach(stores(), (store) => store.forget(id), {concurrency: 1, discard: true}),
				),
		}),
		route: (project, store) => Effect.sync(() => void routes.set(project, store)),
		unroute: (project) => Effect.sync(() => void routes.delete(project)),
	};
};

/** `store` as one owner's restore reads it: only the manifest entries `owns` picks. */
export const ownedView = (store: Store, owns: (entry: ManifestEntry) => boolean): Store =>
	Checkpoints.of({
		...store,
		list: Effect.map(store.list, (entries) => entries.filter(owns)),
	});
