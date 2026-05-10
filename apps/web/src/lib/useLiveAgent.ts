/**
 * Live-updates hook for per-entity Agent DOs (T16).
 *
 * Wraps `useAgent` from `agents/react`. Subscribes to a typed Agent state
 * over WebSocket; emits a fresh `liveSignal` integer every time the
 * Agent's `lastEventId` changes after first-mount. Pages use the signal
 * to bump their Relay `fetchKey` so the GraphQL query re-fetches and the
 * UI lands the new state authoritatively from D1 + the per-entity DO.
 *
 * Why a signal instead of mirroring `state` directly:
 * - The Agent state only carries aggregates (score, count, lastEventId)
 *   — not the full definitions / comments list. The list lives in the
 *   per-DO sqlite; the GraphQL `term(slug)` / `post(idOrSlug)` resolvers
 *   already know how to read it. Refetching is cheap and keeps Relay as
 *   the single source of truth for the rendered tree.
 * - `lastEventId` is a forge ULID minted on every state-changing
 *   mutation (T2/T3 invariant). Comparing the live id against the
 *   mount-time id gives us a strict "something happened after we
 *   loaded" trigger without storing state we don't render directly.
 *
 * Connection lifecycle:
 * - `connected` reflects the WebSocket's open/closed state. The hook
 *   listens on PartySocket's `open` / `close` / `error` events so the
 *   indicator flips immediately on disconnect (sign-out, network drop,
 *   server bounce).
 * - On disconnect, the existing Relay data stays rendered — no flicker —
 *   and the parent page shows a small "canlı güncellemeler duraklatıldı"
 *   pill so the user knows live updates are paused.
 *
 * Server routing: the worker exposes `/agents/<class-kebab>/<name>`
 * via `routeAgentRequest` (worker/index.ts). The DO class names map to
 * kebab-case (`SozlukTerm` → `sozluk-term`, `PanoPost` → `pano-post`).
 */
import * as React from "react";
import {useAgent} from "agents/react";

/**
 * Minimum-viable shape of an Agent state with a `lastEventId` field. Both
 * `TermState` (worker/features/sozluk/SozlukTerm.ts) and `PostState`
 * (worker/features/pano/PanoPost.ts) satisfy this.
 */
export interface LiveAgentStateShape {
	lastEventId: string;
}

export interface UseLiveAgentResult {
	/** Increments every time the Agent's `lastEventId` changes after mount. */
	liveSignal: number;
	/** WebSocket open/closed state — drives the "live paused" indicator. */
	connected: boolean;
}

export interface UseLiveAgentOptions {
	/** Kebab-cased Agent class name (e.g. `sozluk-term`, `pano-post`). */
	agent: string;
	/** Per-instance name (e.g. slug for SozlukTerm, postId for PanoPost). */
	name: string;
	/**
	 * Set to `false` to skip subscribing entirely (e.g. the entity hasn't
	 * been created yet — visiting an unknown slug). When false the hook
	 * returns `{liveSignal: 0, connected: false}` without opening a socket.
	 */
	enabled?: boolean;
}

export function useLiveAgent<State extends LiveAgentStateShape = LiveAgentStateShape>(
	opts: UseLiveAgentOptions,
): UseLiveAgentResult {
	const {agent, name, enabled = true} = opts;

	const [liveSignal, setLiveSignal] = React.useState(0);
	const [connected, setConnected] = React.useState(false);
	// Track the lastEventId we've seen so we only bump the signal when the
	// id actually changes (PartySocket can deliver duplicate state messages
	// on reconnect when the server resends the current snapshot).
	const lastIdRef = React.useRef<string | null>(null);
	// Skip the very first state delivery — that's just the snapshot the
	// server sends on connection establishment, equivalent to what the
	// initial GraphQL query already loaded. We only want to react to
	// state CHANGES that happen after mount.
	const sawInitialRef = React.useRef(false);

	// Reset trackers whenever the subscription target changes. Routing from
	// /sozluk/foo to /sozluk/bar opens a fresh WS to a different DO.
	React.useEffect(() => {
		lastIdRef.current = null;
		sawInitialRef.current = false;
		setLiveSignal(0);
		setConnected(false);
	}, [agent, name, enabled]);

	useAgent<State>({
		agent,
		name,
		// `enabled: false` keeps the hook from opening the underlying socket.
		// We still call the hook unconditionally so React's hook order stays
		// stable across renders.
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
			setLiveSignal((n) => n + 1);
		},
		onOpen: () => setConnected(true),
		onClose: () => setConnected(false),
		onError: () => setConnected(false),
	});

	return {liveSignal, connected: enabled && connected};
}
