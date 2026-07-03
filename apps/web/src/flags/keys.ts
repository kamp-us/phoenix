/**
 * Flag-key constants shared by both halves of the codec — the client (`FlagGate` /
 * `useFlag`) and the server (the IaC declaration in
 * `worker/features/flagship/resources.ts` + the
 * mutation gate). A plain-string module (no alchemy/React import) so it is safe in
 * the worker bundle AND the SPA bundle, mirroring `src/lib/fateWireCodes.ts`.
 * One home per key means the gate and the declaration can never name different
 * strings.
 */

/** Pano taslak (draft-save) dark-ship flag (#746). */
export const PANO_DRAFT_SAVE = "pano-draft-save";

/**
 * Optimistic `post.submit` (feed root-list insert) containment flag (#1676, epic
 * #1637). Default-off: with it off, submit is a plain round-trip; flipping it on
 * enables the optimistic front-of-feed insert that reconciles to the server row.
 * Its own key (not the authorship-loop seam) — an independent per-mutation
 * dark-ship for the Class B root-list optimistic slice.
 */
export const PANO_OPTIMISTIC_SUBMIT = "pano-optimistic-submit";

/**
 * Optimistic `comment.add` (instant nested-thread insert) containment flag (#1678,
 * epic #1637). Default-off: with it off, a new comment/reply joins the thread only
 * when the server `live.comment.thread.appendNode` frame (or the read-back self-heal)
 * lands, exactly as today; flipping it on writes an optimistic temp-node into the
 * nested `Post.comments` connection that reconciles to the server id per ADR 0125
 * (A1 — client-append + canonical-id dedup). Its OWN key (not the epic's shared
 * seam): each optimistic slice has an independent dark-ship lifecycle.
 */
export const PANO_OPTIMISTIC_COMMENT_ADD = "pano-optimistic-comment-add";

/**
 * Optimistic `comment.delete` (instant leaf-drop / `[silindi]` tombstone) containment
 * flag (#1680, epic #1637). Default-off: with it off, a deleted comment leaves/tombstones
 * the thread only when the server `deleteEdge` / `live.update` frame (or the delete-side
 * read-back) lands, exactly as today; flipping it on applies the reply-aware optimistic
 * write per ADR 0125 (D1 — leaf edge-drop vs conservative `[silindi]` tombstone decided
 * from the loaded tree, reconciled by canonical id). Its OWN key (not the epic's shared
 * seam): each optimistic slice has an independent dark-ship lifecycle.
 */
export const PANO_OPTIMISTIC_COMMENT_DELETE = "pano-optimistic-comment-delete";

/**
 * Optimistic `post.delete` (instant feed removal on confirm) dark-ship flag (#1677,
 * epic #1637). Gates the optimistic post-delete flow — evict-and-navigate at once,
 * roll back on rejection — so it reaches production dark; with it off, `post.delete`
 * keeps today's wait-for-round-trip behavior. Its own key (not the epic's shared
 * seam): each Class-B optimistic slice has an independent lifecycle.
 */
export const PANO_OPTIMISTIC_POST_DELETE = "pano-optimistic-post-delete";

/**
 * Earned-authorship loop (çaylak→yazar) dark-ship flag (#1204, epic #1202). The
 * single seam every authorship-loop surface gates behind: cross-cutting
 * (`phoenix`) because the loop touches sözlük/pano/pasaport, default-off so the
 * loop ships dark until a human flips it at release (ADR 0083).
 */
export const PHOENIX_AUTHORSHIP_LOOP = "phoenix-authorship-loop";

/**
 * Bildirim (notification system) dark-ship flag (#1694, epic #1666). The SINGLE
 * seam the whole notification surface gates behind — the spine's unread badge +
 * `/bildirimler` center page and every sibling emitter's surface reuse this one
 * key rather than minting per-child flags. Default-off so the system ships dark
 * until a human flips it at release (ADR 0083).
 */
export const PHOENIX_BILDIRIM = "phoenix-bildirim";

/**
 * Conversion-funnel readout dark-ship flag (#1589). The founder/mod aggregate
 * tier-count surface (`/funnel` + the `funnel.summary` read) gates behind this key;
 * default-off so the readout reaches production dark until a human flips it at
 * release (ADR 0083). Its OWN key, not the `phoenix-authorship-loop` seam — the
 * funnel is a separate mod-only destination with its own lifecycle.
 */
export const PHOENIX_FUNNEL_READOUT = "phoenix-funnel-readout";

/**
 * Optimistic in-place content-edit dark-ship flag (#1675, epic #1637). Gates the
 * three Class-A content edits (`post.edit`, `comment.edit`, `definition.edit`)
 * that render the edited body/title instantly by passing an `optimistic` payload
 * (the seam votes already use); default-off so the edits reach production dark
 * (waiting for the round-trip, exactly as today) until a human flips it at release
 * (ADR 0083). The add/delete slices of the epic ship behind their own gates.
 */
export const PHOENIX_OPTIMISTIC_EDITS = "phoenix-optimistic-edits";

/**
 * Optimistic `definition.add` (instant term-page insert) dark-ship flag (#1679,
 * epic #1637). Gates the A1 client-append into the *nested* `Term.definitions`
 * connection (ADR 0125): with it off, a new definition appears only when the live
 * `appendNode` push (or the read-back refetch) lands, exactly as today; flipping it
 * on injects the optimistic temp-node that fate reconciles to the server id.
 * Default-off so it reaches production dark until a human flips it at release (ADR
 * 0083). Its OWN key, not the epic's shared seam — each nested-mutation optimistic
 * slice has an independent lifecycle (the sibling `comment.add` slice is separate).
 */
export const PHOENIX_OPTIMISTIC_DEFINITION_ADD = "phoenix-optimistic-definition-add";
