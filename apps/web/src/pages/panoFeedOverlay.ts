/**
 * Client-side base+overlay composition for the pano feed (#2323, epic #2316 leg B).
 *
 * The feed splits into a viewer-invariant BASE (post content — title/score/host/…,
 * identical for anon and every signed-in viewer) and a per-viewer OVERLAY (the
 * `myVote`/`isSaved` scalars). The base paints as soon as it lands, de-gated from
 * `get-session`; the overlay composes on top once the session resolves. This module
 * is the pure composition rule — the identity guard that makes the load-bearing
 * invariant structural: a viewer NEVER sees another (or a stale) identity's overlay
 * during composition. An overlay whose landed identity ≠ the current viewer resolves
 * to the neutral (null) state — the same read-path convention the server already
 * degrades to for anon — never a wrong or foreign value.
 */

/** The per-viewer scalar slice composed on top of a base post row. `null` = the neutral,
 *  overlay-pending state (also the anon read-path value): no vote, not saved-known-yet. */
export interface ViewerOverlay {
	readonly myVote: boolean | null;
	readonly isSaved: boolean | null;
}

/** The overlay-pending / anon state: render controls neutral, reserving their landed
 *  footprint so the later patch causes no layout shift. */
export const NEUTRAL_OVERLAY: ViewerOverlay = {myVote: null, isSaved: null};

/**
 * A landed overlay batch, tagged with the identity it was read under. `identity` is the
 * resolved viewer id (`null` for anon); `byId` maps each base row's post id to that
 * viewer's scalars. Tagging the batch with its identity is what lets `resolveOverlay`
 * reject a batch that belongs to a previous identity during a re-key/compose window.
 */
export interface OverlayBatch {
	readonly identity: string | null;
	readonly byId: ReadonlyMap<string, ViewerOverlay>;
}

/** The overlay's lifecycle: `pending` before the viewer's scalars land (base already
 *  painted), then `landed` once they arrive under a known identity. */
export type OverlayState =
	| {readonly status: "pending"}
	| ({readonly status: "landed"} & OverlayBatch);

export const PENDING_OVERLAY: OverlayState = {status: "pending"};

/**
 * Resolve one base row's overlay against the current viewer — the identity guard.
 *
 * Returns the row's scalars ONLY when the overlay has landed AND was read under the
 * SAME identity as the current viewer AND carries this id; otherwise the neutral state.
 * The identity match is the guard: an overlay batch landed under identity A is inert for
 * viewer B (and for anon), so a stale/foreign overlay can never paint — it reads neutral
 * until B's own batch lands. A missing id (a base row the overlay batch didn't cover yet)
 * likewise stays neutral, never borrowing a sibling row's scalars.
 */
export function resolveOverlay(
	state: OverlayState,
	viewerIdentity: string | null,
	id: string,
): ViewerOverlay {
	if (state.status !== "landed") return NEUTRAL_OVERLAY;
	if (state.identity !== viewerIdentity) return NEUTRAL_OVERLAY;
	return state.byId.get(id) ?? NEUTRAL_OVERLAY;
}
