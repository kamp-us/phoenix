/**
 * Deterministic live read-back — the React driver.
 *
 * Wraps a live connection's owning request with a self-healing fallback, in both
 * directions of the server's connection push:
 *
 * - `useReadbackRefetch` → `confirm(newNodeId)`: after the mutator's own create
 *   succeeds, watch the connection for the id; if the server's `appendNode` push
 *   doesn't land it within a short grace window, refetch the owning request
 *   `network-only` so the node appears deterministically (#714).
 * - `useConfirmGone` → `confirmGone(deletedNodeId)`: after the mutator's own delete
 *   succeeds, watch for the id to *leave*; if the server's `deleteEdge` (or the
 *   soft-delete tombstone update) doesn't reconcile it away within the window,
 *   refetch the same way (#1687 — the delete-side gap the add-side left open).
 *
 * The live subscription is untouched — this only frees the *mutator's own* view
 * from depending on a push that can be lost under load. The wait/refetch decisions
 * live in the pure `decideReadback`/`decideConfirmGone` cores (`readback.ts`,
 * unit-tested); the hooks are the timer + the one `fate.request` call. See
 * `.patterns/fate-live-views.md` ("Deterministic read-back").
 */
import * as React from "react";
import {
	DEFAULT_READBACK_PROBES,
	decideConfirmGone,
	decideReadback,
	type ReadbackDecision,
	type ReadbackState,
} from "./readback";

/** Grace tick between probes — long enough for a healthy live push to win, cheap if it doesn't. */
const PROBE_INTERVAL_MS = 1_000;

export interface ReadbackRefetchOptions {
	/** Node ids the connection currently holds — pass the live `items` mapped to their ids. */
	presentIds: ReadonlyArray<string>;
	/**
	 * Refetch the owning request through the network so the lost push is reconciled.
	 * Called at most once per pending read-back, only when the live push didn't win
	 * the race.
	 */
	refetch: () => Promise<unknown>;
	/** Probe budget before falling back (default {@link DEFAULT_READBACK_PROBES}). */
	probes?: number;
}

/** The shared timer/refetch loop; `decide` picks the direction (appear vs gone). */
function useReadbackDriver(
	options: ReadbackRefetchOptions,
	decide: (presentIds: ReadonlySet<string>, state: ReadbackState) => ReadbackDecision,
): (nodeId: string) => void {
	const probes = options.probes ?? DEFAULT_READBACK_PROBES;

	// Present ids + refetch can change every render; hold them in a ref so the probe
	// loop always reads the latest set without re-arming on each render.
	const presentRef = React.useRef(options.presentIds);
	presentRef.current = options.presentIds;
	const refetchRef = React.useRef(options.refetch);
	refetchRef.current = options.refetch;

	const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const refetchedFor = React.useRef<string | null>(null);

	const clear = React.useCallback(() => {
		if (timer.current != null) {
			clearTimeout(timer.current);
			timer.current = null;
		}
	}, []);

	React.useEffect(() => clear, [clear]);

	return React.useCallback(
		(nodeId: string) => {
			clear();
			refetchedFor.current = null;

			const probe = (state: ReadbackState) => {
				const decision = decide(new Set(presentRef.current), state);
				if (decision.action === "settled") return;
				if (decision.action === "wait") {
					timer.current = setTimeout(() => probe(decision.next), PROBE_INTERVAL_MS);
					return;
				}
				// refetch — fire the network read-back at most once per pending node.
				if (refetchedFor.current === nodeId) return;
				refetchedFor.current = nodeId;
				void refetchRef.current().catch(() => undefined);
			};

			probe({expectedId: nodeId, probesRemaining: probes});
		},
		[clear, probes, decide],
	);
}

/**
 * Returns `confirm(nodeId)`: call it with the id of the node the mutator just
 * created. Resolves silently the moment the node is present (live push won) or once
 * the fallback refetch has fired. Safe to call repeatedly; the latest expected id
 * wins and an in-flight probe loop is replaced.
 */
export function useReadbackRefetch(options: ReadbackRefetchOptions): (nodeId: string) => void {
	return useReadbackDriver(options, decideReadback);
}

/**
 * Returns `confirmGone(nodeId)`: call it with the id of the node the mutator just
 * deleted. Resolves silently the moment the id has left `presentIds` (the live
 * `deleteEdge`/tombstone won) or once the fallback refetch has fired. Pass the ids
 * a lost delete would leave *stuck* — for a list with soft-delete tombstones, the
 * visible (non-tombstoned) ids, so both server outcomes settle.
 */
export function useConfirmGone(options: ReadbackRefetchOptions): (nodeId: string) => void {
	return useReadbackDriver(options, decideConfirmGone);
}
