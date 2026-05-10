/**
 * Live-updates hook v2 — `commitLocalUpdate` flavor (task_1, phoenix-relay-idiom).
 *
 * v1 (`useLiveAgent.ts`) bumped a `liveSignal` integer that consumers wired
 * into Relay's `fetchKey`, forcing a full page query refetch on every Agent
 * state change. That refetch suspended the page tree, which made every
 * downstream Playwright spec depend on `page.reload()` to escape the
 * Suspense double-mount race. The whole `phoenix-relay-idiom` feature
 * exists to undo that.
 *
 * v2 keeps the WebSocket subscription primitive (`useAgent` from
 * `agents/react`) but removes the refetch entirely. Each consumer page
 * provides an `applyToStore` callback that translates the Agent's typed
 * state into Relay store writes via `commitLocalUpdate`. The page tree
 * never unmounts. The `connected` boolean is the only thing the caller
 * gets back — the `LivePill` indicator UX from MVP T16 stays exactly the
 * same.
 *
 * Page migrations (tasks 3-4) wire the actual `applyToStore` callbacks
 * (Term aggregates, Post aggregates, ConnectionHandler edge inserts).
 * v1 (`useLiveAgent.ts`) stays untouched in this task — both hooks coexist
 * during the migration window. Cleanup task (7) deletes v1 and renames v2.
 */

import {useAgent} from "agents/react";
import * as React from "react";
import {useRelayEnvironment} from "react-relay";
import {commitLocalUpdate, type RecordSourceProxy} from "relay-runtime";

/**
 * Minimum-viable shape of an Agent state with a `lastEventId` field. Both
 * `TermState` (worker/features/sozluk/SozlukTerm.ts) and `PostState`
 * (worker/features/pano/PanoPost.ts) satisfy this. Carried forward from
 * v1 so consumers can keep the same state type imports.
 */
export interface LiveAgentStateShape {
	lastEventId: string;
}

export interface UseLiveAgentV2Result {
	/**
	 * WebSocket open/closed state — drives the "live paused" indicator
	 * (`LivePill` from MVP T16). Identical semantics to v1.
	 */
	connected: boolean;
}

export interface UseLiveAgentV2Options<State extends LiveAgentStateShape> {
	/** Kebab-cased Agent class name (e.g. `sozluk-term`, `pano-post`). */
	agent: string;
	/** Per-instance name (e.g. slug for SozlukTerm, postId for PanoPost). */
	name: string;
	/**
	 * Apply the latest Agent state into the Relay store. Invoked inside a
	 * `commitLocalUpdate` block — the `store` argument is a fresh
	 * {@link RecordSourceProxy} scoped to that update.
	 *
	 * Implementations typically:
	 *  - update denormalized aggregates on the parent record
	 *    (`Term:${slug}`, `Post:${postId}`)
	 *  - insert / update edges in known connection records via
	 *    `ConnectionHandler` for new comments / definitions arriving
	 *    over the WebSocket
	 */
	applyToStore: (state: State, store: RecordSourceProxy) => void;
	/**
	 * Set to `false` to skip subscribing entirely (e.g. visiting an
	 * unknown slug). When false the hook returns
	 * `{connected: false}` without opening a socket. The hook is still
	 * called unconditionally so React's hook ordering stays stable.
	 */
	enabled?: boolean;
}

export function useLiveAgentV2<State extends LiveAgentStateShape = LiveAgentStateShape>(
	opts: UseLiveAgentV2Options<State>,
): UseLiveAgentV2Result {
	const {agent, name, applyToStore, enabled = true} = opts;

	const [connected, setConnected] = React.useState(false);
	const environment = useRelayEnvironment();

	// Track the lastEventId we've seen so we only commit when the id
	// actually changes. PartySocket can deliver duplicate state messages
	// on reconnect when the server resends the current snapshot.
	const lastIdRef = React.useRef<string | null>(null);
	// Skip the very first state delivery — that's the snapshot the server
	// sends on connection establishment, equivalent to what the initial
	// GraphQL query already loaded into the store. We only commit on
	// CHANGES that happen after mount.
	const sawInitialRef = React.useRef(false);
	// Stash the latest callback in a ref so the `useAgent` hook doesn't
	// see a fresh callback every render — `applyToStore` is typically a
	// closure over component state and would otherwise churn the
	// underlying socket subscription.
	const applyToStoreRef = React.useRef(applyToStore);
	React.useEffect(() => {
		applyToStoreRef.current = applyToStore;
	}, [applyToStore]);

	// Reset trackers whenever the subscription target changes. Routing
	// from /sozluk/foo to /sozluk/bar opens a fresh WS to a different DO.
	React.useEffect(() => {
		lastIdRef.current = null;
		sawInitialRef.current = false;
		setConnected(false);
	}, [agent, name, enabled]);

	useAgent<State>({
		agent,
		name,
		// `enabled: false` keeps the hook from opening the underlying socket.
		// Caller still invokes the hook; React's ordering stays stable.
		enabled,
		onStateUpdate: (state: State, source: "server" | "client") => {
			if (source !== "server") return;
			const nextId = state.lastEventId;
			if (!nextId) return;
			if (!sawInitialRef.current) {
				sawInitialRef.current = true;
				lastIdRef.current = nextId;
				return;
			}
			if (nextId === lastIdRef.current) return;
			lastIdRef.current = nextId;
			// Translate the new Agent state into store writes. Wrapped in
			// `commitLocalUpdate` so Relay's normal subscription mechanism
			// notifies every component reading the changed records — no
			// refetch, no Suspense, no page unmount.
			commitLocalUpdate(environment, (store) => {
				applyToStoreRef.current(state, store);
			});
		},
		onOpen: () => setConnected(true),
		onClose: () => setConnected(false),
		onError: () => setConnected(false),
	});

	return {connected: enabled && connected};
}
