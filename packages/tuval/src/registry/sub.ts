/**
 * A Sub as `@demlik/tea` 0.18 declares one, owned here while the repo still pins 0.12.
 *
 * 0.18 makes a machine's Subs data only: each entry is `{type, deps}`, its id is derived from both,
 * and the engine runs the runner registered for that `type`. 0.12's `DepKeyedSub` is the older
 * inline-runner shape (`{deps, source}`), so these types stand in with 0.18's exact shape until the
 * pin child (#9787) swaps them for tea's own. `desiredSub` mirrors 0.18's function of the same name.
 */

import {type SubId, structuralHash, subId} from "@demlik/tea";

/** One running Sub as its runner sees it: the entry's `type`, the `deps` it was opened for, the id of both. */
export type Sub<T extends string = string, D = unknown> = {
	readonly id: SubId;
	readonly type: T;
	readonly deps: D;
};

/**
 * One Sub a machine declares. `deps` answers the slice of state the Sub depends on; `null` or
 * `undefined` means the Sub is off in that state. Plain JSON-compatible data only: the id is a
 * structural hash, which throws on a `Date`, `Map`, `Set` or class instance.
 */
export type DepKeyedSub<S, U extends Sub = Sub> =
	U extends Sub<infer T, infer D>
		? {readonly type: T; readonly deps: (state: S) => D | null | undefined}
		: never;

/** The one id of a Sub: same type and same deps is the same id, so the running Sub is left alone. */
export const subIdOf = (type: string, deps: unknown): SubId => subId(structuralHash({type, deps}));

/**
 * The Sub `entry` asks for in `state`, or `null` when its deps are off. Throws whatever `deps` or the
 * hash throws; the host reads that as a reconcile failure.
 */
export const desiredSub = <S, U extends Sub>(entry: DepKeyedSub<S, U>, state: S): U | null => {
	const {type, deps: depsOf} = entry as {
		readonly type: string;
		readonly deps: (state: S) => unknown;
	};
	const deps = depsOf(state);
	if (deps === null || deps === undefined) return null;
	// The entry that produced `deps` is the one of type `type`, so this is `U`'s member for it.
	return {id: subIdOf(type, deps), type, deps} as U;
};

/** Every Sub a machine's entries ask for in `state`, in declaration order, one per id. */
export const desiredSubs = <S, U extends Sub>(
	entries: ReadonlyArray<DepKeyedSub<S, U>> | undefined,
	state: S,
): ReadonlyArray<U> => {
	const desired = new Map<string, U>();
	for (const entry of entries ?? []) {
		const sub = desiredSub(entry, state);
		if (sub !== null) desired.set(sub.id, sub);
	}
	return [...desired.values()];
};
