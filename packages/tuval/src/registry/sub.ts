/**
 * Which Subs a machine's `{type, deps}` entries ask for in a state. The shapes are `@demlik/tea`'s
 * own `Sub` and `DepKeyedSub`; `desiredSub` mirrors tea's internal function of the same name, so
 * a test can read which Subs a state asks for without running the engine.
 */

import {type DepKeyedSub, type Sub, subIdOf} from "@demlik/tea";

export type {DepKeyedSub, Sub};
export {subIdOf};

/**
 * The Sub `entry` asks for in `state`, or `null` when its deps are off. Throws whatever `deps` or the
 * hash throws; tea's run reads the same throw as a reconcile failure.
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
