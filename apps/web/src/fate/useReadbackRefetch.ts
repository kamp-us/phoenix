/**
 * Deterministic live read-back — the React driver. It frees only the *mutator's own*
 * view from depending on a push that can be lost under load; the live subscription is
 * untouched. See `.patterns/fate-live-consistency.md#read-back`.
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
	refetch: () => Promise<unknown>;
	probes?: number;
}

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
				if (refetchedFor.current === nodeId) return;
				refetchedFor.current = nodeId;
				void refetchRef.current().catch(() => undefined);
			};

			probe({expectedId: nodeId, probesRemaining: probes});
		},
		[clear, probes, decide],
	);
}

export function useReadbackRefetch(options: ReadbackRefetchOptions): (nodeId: string) => void {
	return useReadbackDriver(options, decideReadback);
}

/**
 * `presentIds` here must be the ids a lost delete would leave *stuck* — for a list
 * with soft-delete tombstones, the visible (non-tombstoned) ids, so both server
 * outcomes settle.
 */
export function useConfirmGone(options: ReadbackRefetchOptions): (nodeId: string) => void {
	return useReadbackDriver(options, decideConfirmGone);
}
