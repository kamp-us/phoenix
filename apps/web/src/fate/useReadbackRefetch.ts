/**
 * Deterministic live read-back — the React driver.
 *
 * Wraps a live connection's owning request with a self-healing fallback: after the
 * mutator's own create succeeds, `confirm(newNodeId)` watches the connection for
 * that id and, if the server's `appendNode` push doesn't land it within a short
 * grace window, refetches the owning request `network-only` so the node appears
 * deterministically. The live subscription is untouched — this only frees the
 * *mutator's own* view from depending on a push that can be lost under load (#714).
 *
 * The wait/refetch decision lives in the pure `decideReadback` core (`readback.ts`,
 * unit-tested); this hook is the timer + the one `fate.request` call. See
 * `.patterns/fate-live-views.md` ("Deterministic read-back").
 */
import * as React from "react";
import {useFateClient} from "react-fate";
import {DEFAULT_READBACK_PROBES, decideReadback, type ReadbackState} from "./readback";

/** Grace tick between probes — long enough for a healthy live push to win, cheap if it doesn't. */
const PROBE_INTERVAL_MS = 1_000;

export interface ReadbackRefetchOptions {
	/** Node ids the connection currently holds — pass the live `items` mapped to their ids. */
	presentIds: ReadonlyArray<string>;
	/**
	 * Refetch the owning request through the network so the lost node lands. Called
	 * at most once per pending read-back, only when the live push didn't win the race.
	 */
	refetch: () => Promise<unknown>;
	/** Probe budget before falling back (default {@link DEFAULT_READBACK_PROBES}). */
	probes?: number;
}

/**
 * Returns `confirm(nodeId)`: call it with the id of the node the mutator just
 * created. Resolves silently the moment the node is present (live push won) or once
 * the fallback refetch has fired. Safe to call repeatedly; the latest expected id
 * wins and an in-flight probe loop is replaced.
 */
export function useReadbackRefetch(options: ReadbackRefetchOptions): (nodeId: string) => void {
	const fate = useFateClient();
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
				const decision = decideReadback(new Set(presentRef.current), state);
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
		[clear, probes, fate],
	);
}
