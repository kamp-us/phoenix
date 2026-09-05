/**
 * The two things this renderer needs that the window contract does not carry, and where they come
 * from.
 *
 * A `WindowHost` gives a renderer its own process and nothing about anyone else's, so the process
 * table has to arrive some other way. Founder ruling 2 on #7500 fixes which way: the desk
 * `Snapshot` the page already holds, and no port of this program's own — "ideally anything that's
 * in the browser should be using the same single relay in the browser". `processes` here is
 * `Snapshot.processes` verbatim, so the canvas and the `ps` table read one array and can never
 * disagree.
 *
 * `callSpell` is the way out. Everything this view does to the desk — putting a process in a window
 * — is a spell call the shell already owns (`window:attach`, #7557), so nothing here writes shell
 * state and this program builds no window binding of its own.
 *
 * Both are read through one React context because they change together and per snapshot: the
 * provider re-renders, the canvas re-derives, and there is no place for a stale copy to live.
 */

import {createContext, type ReactNode, useContext} from "react";
import type {SpellPath} from "../../../protocol/ids.ts";
import type {ProcessRow} from "../../../protocol/process-row.ts";

/** One call at the shell's spell registry. Fire and forget: the reply reaches the desk, not a window. */
export type SpellCaller = (path: SpellPath, args: Readonly<Record<string, unknown>>) => void;

export interface DeskAccess {
	/** `Snapshot.processes` — the only source of process facts this program reads. */
	readonly processes: ReadonlyArray<ProcessRow>;
	readonly callSpell: SpellCaller;
}

/**
 * What an unprovided context answers. An empty table and a caller that does nothing, because a
 * window whose provider is missing must render an empty canvas rather than take the desk down with
 * it — the desk is the shell's, and one program's wiring gap is not the shell's failure.
 */
const detached: DeskAccess = {processes: [], callSpell: () => {}};

const DeskAccessContext = createContext<DeskAccess>(detached);

export function DeskAccessProvider({
	value,
	children,
}: {
	readonly value: DeskAccess;
	readonly children: ReactNode;
}): ReactNode {
	return <DeskAccessContext value={value}>{children}</DeskAccessContext>;
}

export const useDeskAccess = (): DeskAccess => useContext(DeskAccessContext);
