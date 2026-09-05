/**
 * Where the `ps` table gets the two things a window host does not carry: the desk's `Snapshot`
 * rows, and a way to put a spell call on the wire.
 *
 * A `WindowHost` is scoped to one process — its state and its Msgs — and the process table is desk
 * state, so it arrives beside the host rather than through it. Founder ruling 2 fixes where from:
 * `Snapshot.processes`, the one channel the canvas reads too, so the two views can never disagree.
 * A context rather than a factory argument because the page's renderer table is built once and the
 * snapshot changes on every patch.
 *
 * With no provider above it the table renders its own placeholder. That is the arm the "reads the
 * Snapshot and nothing else" test stands on: wire nothing but this provider and the table works;
 * wire everything but this provider and it has no process facts at all.
 */

import {createContext, type ReactElement, type ReactNode, useContext} from "react";
import type {ProcessRow} from "../../protocol/process-row.ts";
import type {SpellCaller} from "./attach.ts";

export interface PsSource {
	/** `Snapshot.processes`, verbatim. The table converts and orders; it never fetches. */
	readonly processes: ReadonlyArray<ProcessRow>;
	readonly spells: SpellCaller;
}

const PsSourceContext = createContext<PsSource | null>(null);

export interface PsSourceProviderProps {
	readonly source: PsSource;
	readonly children: ReactNode;
}

export function PsSourceProvider({source, children}: PsSourceProviderProps): ReactElement {
	return <PsSourceContext.Provider value={source}>{children}</PsSourceContext.Provider>;
}

/** The desk's rows and spell caller, or nothing when no provider is above. */
export const usePsSource = (): PsSource | null => useContext(PsSourceContext);
