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
 * Base-feed / viewer-overlay split dark-ship flag (#2322, epic #2316 leg B). The
 * SINGLE seam every leg-B surface gates behind — the server split (the GET-able
 * viewer-invariant base feed + the authed `PostOverlay` read), the client
 * composition (#2323), and the edge cache (#2324) reuse this one key. Default-off
 * so the whole base/overlay path ships dark until a human flips it at release (ADR
 * 0083): with it off the `GET /fate/pano/feed` route 404s, the `PostOverlay` source
 * resolves inert (null scalars), and the existing per-viewer `posts` feed is the
 * unchanged source of truth. Its own `pano-` key (the surface is pano-only).
 */
export const PANO_BASE_FEED = "pano-base-feed";

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
 * Moderation-queue surface dark-ship flag (#1701). The moderator-only raporlar
 * view inside `/divan` (the `report.listOpen` queue) gates behind this key;
 * default-off so the surface reaches production dark until a human flips it at
 * release (ADR 0083). Its OWN key, not the `phoenix-authorship-loop` seam — the
 * moderation queue is a separate mod-only surface with its own lifecycle
 * (the `PHOENIX_FUNNEL_READOUT` precedent).
 */
export const PHOENIX_MOD_QUEUE = "phoenix-mod-queue";

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

/**
 * Optimistic `definition.delete` (instant term-page drop) dark-ship flag (#1681,
 * epic #1637). Gates the D1 edge-drop from the *nested* `Term.definitions`
 * connection (ADR 0125): with it off, a deleted definition leaves the term page
 * only when the live `deleteEdge` push (or the delete-side read-back) lands, exactly
 * as today; flipping it on removes the edge from the nested list state the instant
 * deletion is confirmed, reconciled against the server `deleteEdge` by canonical id
 * (no reappear) and restored on rejection. `definition.delete` has no reply tree, so
 * D1 collapses to a plain edge-drop — no tombstone branch. Default-off so it reaches
 * production dark until a human flips it at release (ADR 0083). Its OWN key, not the
 * epic's shared seam — each optimistic slice has an independent lifecycle (the
 * sibling `comment.delete` slice is separate).
 */
export const PHOENIX_OPTIMISTIC_DEFINITION_DELETE = "phoenix-optimistic-definition-delete";

/**
 * Reactions (emoji tepki) dark-ship flag (#1863, epic #1840). The SINGLE seam the
 * whole reaction feature gates behind — the react/change/retract mutations and the
 * `reactions` view field on every surface (pano post/comment, sözlük definition)
 * reuse this one key rather than minting a per-surface flag, so one human flip
 * releases the whole ungated social-signal affordance. Default-off so the feature
 * reaches production dark until a human flips it at release (ADR 0083). Its OWN
 * cross-cutting (`phoenix`) key — the template spans both products, mirroring the
 * `phoenix-authorship-loop` / `phoenix-bildirim` shared-seam precedent.
 */
export const PHOENIX_REACTIONS = "phoenix-reactions";

/**
 * Karma-gated privileges dark-ship flag (#150, künye epic #41). The SINGLE seam
 * the karma-value privilege gates ride behind — the post-floor (`karma ≥ −4`, on
 * content creation) and the flag-floor (`karma ≥ 50`, on `report.submit`). With
 * it OFF the gates are inert: no karma read runs and every write behaves exactly
 * as today, so the gates reach production dark until a human flips the flag at
 * release (ADR 0083). Default-off, its own cross-cutting (`phoenix`) key — the
 * gates span both products (pano/sözlük creation) and the moderation surface, the
 * `phoenix-authorship-loop` / `phoenix-reactions` shared-seam precedent.
 *
 * Deliberately distinct from the çaylak→yazar *tier* gates (authorship level) and
 * the ADR 0098 moderation surface: these are karma-VALUE floors (anti-abuse), not
 * a second tier ladder — no double-gating (#150 rescope, 2026-07-02).
 */
export const PHOENIX_KARMA_GATES = "phoenix-karma-gates";
