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
 * Sözlük parallel-stamp-wave containment flag (#2709, epic #2567). Default-off. The
 * sözlük definition reads (`getDefinitionsByIds` / `listDefinitionsKeyset`) always
 * route their independent stamps through the shared `parallelStampWave`; this flag is
 * the concurrency knob it passes — OFF ⇒ the wave runs at `concurrency: 1` (the reads
 * stay serial, byte-for-byte today's behavior), ON ⇒ `"unbounded"` collapses the stamp
 * chain into one concurrent wave (the #2567 win). Flipping it on is the human release
 * act (ADR 0083). Its own `phoenix-` key — the combinator is cross-product (the pano
 * sibling #2710 ships behind its own seam), read-path only.
 *
 * @reachability-exempt: server read-path performance flag, no user-facing surface (identical wire output either way; only wall time changes).
 */
export const PHOENIX_SOZLUK_STAMP_WAVE = "phoenix-sozluk-stamp-wave";

/**
 * Pano parallel-stamp-wave containment flag (#2710, epic #2567) — the pano sibling of
 * {@link PHOENIX_SOZLUK_STAMP_WAVE}, behind its own seam. The pano thread/comment reads
 * (`getCommentsByIds` / `listCommentsKeyset`) always route their independent stamps
 * through the shared `parallelStampWave`; this flag is the concurrency knob it passes —
 * OFF ⇒ the wave runs at `concurrency: 1` (the reads stay serial, byte-for-byte today's
 * behavior), ON ⇒ `"unbounded"` collapses the stamp chain into one concurrent wave (the
 * #2567 win). Flipping it on is the human release act (ADR 0083). Scoped to the thread
 * read only — NOT the pano feed (`listPostsConnection`), which is the #2322 base/overlay
 * split.
 *
 * @reachability-exempt: server read-path performance flag, no user-facing surface (identical wire output either way; only wall time changes).
 */
export const PHOENIX_PANO_STAMP_WAVE = "phoenix-pano-stamp-wave";

/**
 * mecmua write-path dark-ship flag (#2497, epic #2467). The single seam the mecmua
 * write surface gates behind — the `mecmua.publish` + `mecmua.saveDraft` mutations
 * fail `MECMUA_DISABLED` with it off, so the whole write path ships dark until a
 * human flips it at release (ADR 0083). Its own `mecmua-` product key.
 */
export const MECMUA_WRITE = "mecmua-write";

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
 * mecmua public-read dark-ship flag (#2498, epic #2467). The SINGLE seam the
 * anonymous read surface gates behind — the `GET /fate/mecmua/post/:slug` route's
 * existence (404 until flipped) AND the `/mecmua/:slug` reader page (self-404).
 * Default-off so the whole public-read path ships dark until a human flips it at
 * release (ADR 0083). Its own `mecmua-` key, scoped to the read surface — the
 * authoring/publish path (#2497) ships behind its own seam.
 */
export const MECMUA_PUBLIC_READ = "mecmua-public-read";

/**
 * mecmua subscribed-author feed dark-ship flag (#2500, epic #2467). The SINGLE seam
 * the feed surface gates behind — the `mecmuaFeed` list root (empty when off), the
 * `mecmua.subscribe` / `mecmua.unsubscribe` mutations, AND the `/mecmua` feed page
 * (self-404). Default-off so the whole feed path ships dark until a human flips it at
 * release (ADR 0083). Its own `mecmua-` key, scoped to the feed — the read (#2498) and
 * write (#2497) paths ship behind their own seams.
 */
export const MECMUA_FEED = "mecmua-feed";

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

/**
 * User ban/unban dark-ship flag (#970, admin epic #968). The SINGLE seam the ban
 * surface gates behind — the `user.banUser` / `user.unbanUser` admin mutations, the
 * `user.banState` admin read, AND the moderator-UI ban controls all read this one
 * key. Default-off so the whole ban path (server + client) reaches production dark
 * until a human flips it at release (ADR 0083): with it off the mutations/read fail
 * the invisible `Denied` (like a non-admin call) and the client controls render
 * nothing, so no session is ever refused by an unreleased feature. Its OWN key, not
 * a shared authz seam — ban is a distinct admin capability with its own lifecycle
 * (the `phoenix-funnel-readout` mod-surface precedent).
 */
export const PHOENIX_USER_BAN = "phoenix-user-ban";

/**
 * Platform-role assignment dark-ship flag (#3522, admin epic per ADR 0107). The SINGLE
 * seam the `Admin.over(platform)`-gated `user.setRole` mutation gates behind — the writer
 * for the `moderates` relation tuple #969/PR #1266's offline mint never gave the console.
 * Default-off so the whole role-assign path reaches production dark until a human flips it
 * at release (ADR 0083): with it off the mutation fails the invisible `Denied` (like a
 * non-admin call), so an unreleased role-grant can never mint a moderator. Its OWN key,
 * not the ban/email-admin seam — role-assign is a distinct admin capability with its own
 * lifecycle (the `phoenix-user-ban` / `phoenix-email-delivery-admin` admin-surface
 * precedent). The #3203 roster affordance wires onto this mutation later.
 */
export const PHOENIX_USER_ROLE_ASSIGN = "phoenix-user-role-assign";

/**
 * Admin email-delivery (failing-address) surface dark-ship flag (#2692, email-bounce
 * epic #2687). The SINGLE seam the admin failing-address surface gates behind — the
 * `emailDelivery.mark` / `emailDelivery.clear` admin mutations AND the
 * `emailDelivery.failing` admin roll-up read all read this one key. Default-off so the
 * whole admin path reaches production dark until a human flips it at release (ADR 0083):
 * with it off the mutations/read fail the invisible `Denied` (like a non-admin call), so
 * no manual failing-mark or roll-up leaks before release. Its OWN key, not the ban seam —
 * the manual failing-address surface is a distinct admin capability with its own lifecycle
 * (the `phoenix-user-ban` admin-surface precedent).
 */
export const PHOENIX_EMAIL_DELIVERY_ADMIN = "phoenix-email-delivery-admin";

/**
 * Failing-email membrane notice dark-ship flag (#2693, email-bounce epic #2687). The seam the
 * user-facing notice gates behind — with it off the membrane mount renders nothing, so the
 * surface ships dark until a human flips it at release (ADR 0083). Default-off, its own
 * `phoenix-` key: the notice is a cross-product membrane element, not scoped to one product.
 */
export const PHOENIX_EMAIL_DELIVERY_NOTICE = "phoenix-email-delivery-notice";

/**
 * Nav-IA (per-product Subnav zones) dark-ship flag (#2598, epic #2596). The SINGLE
 * cross-cutting seam the whole nav-IA surface gates behind — the per-product nested
 * layout routes + Subnav CTA slot substrate (#2598) and every per-product delta
 * (#2600–#2604) reuse this one key rather than minting per-child flags, so one human
 * flip releases the new product zones as a unit. Default-off so the surface ships dark
 * until a human flips it at release (ADR 0083): with it off the router is exactly as
 * today (flat product routes, no product Subnav zone). Its own cross-cutting (`phoenix`)
 * key — the placement law spans all four products (sözlük/pano/mecmua/divan), the
 * `phoenix-authorship-loop` / `phoenix-reactions` shared-seam precedent.
 */
export const PHOENIX_NAV_IA = "phoenix-nav-ia";

/**
 * Admin-console shell dark-ship flag (#2740, epic #2711). The SINGLE seam the whole
 * in-product admin console gates behind — the `/admin` route, the client `admin.probe`
 * signal that decides whether to mount+fetch the lazy console bundle, AND the worker
 * `admin.probe` gated read all key off this one string. Default-off so the console
 * reaches production dark until a human flips it at release (ADR 0083): with it off the
 * probe short-circuits (client) / fails the invisible `Denied` (server) for everyone, so
 * the route resolves inert (the ordinary not-found state) and no console chunk is ever
 * fetched. Its OWN cross-cutting (`phoenix`) key — the console is a host for future
 * admin modules (flags is module #1, #2742), each of which keeps its own capability
 * lifecycle behind its own flag (the `phoenix-user-ban` admin-surface precedent).
 */
export const PHOENIX_ADMIN_CONSOLE = "phoenix-admin-console";

/**
 * Kullanıcılar (user-roster) admin-console module dark-ship flag (#3200, admin epic).
 * The SINGLE seam the gated user-list read view gates behind — the `userAdmin.list`
 * admin fate resolver AND the `kullanıcılar` console panel both key off this one string.
 * Default-off so the whole roster surface reaches production dark until a human flips it
 * at release (ADR 0083): with it off the server read fails the invisible `Denied` (like a
 * non-admin call) and the panel renders nothing, so the roster never leaks before release.
 * Its OWN key, not the `phoenix-admin-console` shell seam — the roster is a distinct admin
 * capability (read the user list) with its own lifecycle, hosted BY the shipped console
 * shell (the `phoenix-user-ban` / `phoenix-email-delivery-admin` admin-surface precedent).
 * The per-user actions (role-assign, ban/unban) wire into this roster behind their own
 * seams later — this key gates the read view only.
 */
export const PHOENIX_USER_ADMIN = "phoenix-user-admin";

/**
 * Edge-resolved shell-boot containment flag (#2928, epic #2926, ADR 0179). The SINGLE seam
 * the whole worker-first shell render ships behind — with it OFF the SPA HTML stays
 * edge-direct byte-identical to today (the `assets` binding serves it, the worker never
 * touches it); with it ON the worker renders the shell per request and injects
 * `window.__BOOT__` (the shell-key manifest flags under full-session userId context +
 * `signedIn`). Default-off so the whole edge-render path reaches production dark until a
 * human flips it at release (ADR 0083). Its own cross-cutting (`phoenix`) key — the render
 * path spans every product's shell geometry.
 */
export const PHOENIX_EDGE_SHELL_BOOT = "phoenix-edge-shell-boot";

/**
 * Profile free-paint canvas (duvar) dark-ship flag (#3103, epic #2035). The SINGLE seam
 * the whole profile-canvas feature gates behind — the fate read view + visitor render
 * (#3105), the owner enable/toggle mutation (#3108), and the paint/save surface (#3109)
 * all key off this one string rather than minting per-child flags, so one human flip
 * releases the mural as a unit. Default-off so the feature ships dark until a human flips
 * it at release (ADR 0083). Its own `profile-` key, scoped to the profile surface.
 */
export const PROFILE_CANVAS = "profile-canvas";

/**
 * Member-mute (sustur) write-path dark-ship flag (#3112, epic #2035). The SINGLE seam
 * the mute write path gates behind — the `mute.set` / `mute.remove` fate mutations fail
 * closed (`MUTE_DISABLED`) with it off, so the whole primitive ships dark until a human
 * flips it at release (ADR 0083): with it off no member can mute another even if a client
 * bypasses the (not-yet-built) UI. Default-off, its own `member-` key scoped to the
 * member-relation surface. The read-mask that consumes a mute (sibling) and the manage
 * UI (reachability child) ship behind their own slices.
 */
export const MEMBER_MUTE = "member-mute";

/** A declared flag paired with its default variation — the row the flags console lists (#2742). */
export interface FlagDeclaration {
	readonly key: string;
	/** The declared default variation (mirrors `resources.ts`; every containment flag is off). */
	readonly defaultValue: boolean;
}

/**
 * The declared flags enumerated for a UI that must list them all — the flags console module
 * (#2742) reads this to render one on/off/clear row per flag. The plain constants above are the
 * single home for the key *strings*; this array is their enumeration, so the console can never
 * name a flag that isn't declared here. Every entry is a default-off containment flag (each key's
 * docblock above; the server default lives in `worker/features/flagship/resources.ts`).
 */
export const DECLARED_FLAGS: readonly FlagDeclaration[] = [
	{key: PANO_DRAFT_SAVE, defaultValue: false},
	{key: PHOENIX_SOZLUK_STAMP_WAVE, defaultValue: false},
	{key: PHOENIX_PANO_STAMP_WAVE, defaultValue: false},
	{key: MECMUA_WRITE, defaultValue: false},
	{key: PANO_BASE_FEED, defaultValue: false},
	{key: MECMUA_PUBLIC_READ, defaultValue: false},
	{key: MECMUA_FEED, defaultValue: false},
	{key: PHOENIX_AUTHORSHIP_LOOP, defaultValue: false},
	{key: PHOENIX_BILDIRIM, defaultValue: false},
	{key: PHOENIX_FUNNEL_READOUT, defaultValue: false},
	{key: PHOENIX_OPTIMISTIC_EDITS, defaultValue: false},
	{key: PHOENIX_OPTIMISTIC_DEFINITION_ADD, defaultValue: false},
	{key: PHOENIX_OPTIMISTIC_DEFINITION_DELETE, defaultValue: false},
	{key: PHOENIX_REACTIONS, defaultValue: false},
	{key: PHOENIX_KARMA_GATES, defaultValue: false},
	{key: PHOENIX_USER_BAN, defaultValue: false},
	{key: PHOENIX_USER_ROLE_ASSIGN, defaultValue: false},
	{key: PHOENIX_EMAIL_DELIVERY_ADMIN, defaultValue: false},
	{key: PHOENIX_EMAIL_DELIVERY_NOTICE, defaultValue: false},
	{key: PHOENIX_NAV_IA, defaultValue: false},
	{key: PHOENIX_ADMIN_CONSOLE, defaultValue: false},
	{key: PHOENIX_USER_ADMIN, defaultValue: false},
	{key: PHOENIX_EDGE_SHELL_BOOT, defaultValue: false},
	{key: PROFILE_CANVAS, defaultValue: false},
	{key: MEMBER_MUTE, defaultValue: false},
];
