/**
 * Flag-key constants shared by the client gates and the server's IaC declaration
 * (`worker/features/flagship/resources.ts`). Plain strings, no alchemy/React import, so the module
 * is safe in the worker bundle AND the SPA bundle.
 */

/**
 * Concurrency knob the sözlük definition reads pass to the shared `parallelStampWave` (#2709):
 * off ⇒ `concurrency: 1` (serial, today's behavior), on ⇒ `"unbounded"`. Default-off, ADR 0083.
 *
 * @reachability-exempt: server read-path performance flag, no user-facing surface (identical wire output either way; only wall time changes).
 */
export const PHOENIX_SOZLUK_STAMP_WAVE = "phoenix-sozluk-stamp-wave";

/**
 * The pano sibling of {@link PHOENIX_SOZLUK_STAMP_WAVE} (#2710), behind its own seam. Scoped to
 * the thread/comment reads only — NOT the pano feed (`listPostsConnection`), which is the #2322
 * base/overlay split. Default-off, ADR 0083.
 *
 * @reachability-exempt: server read-path performance flag, no user-facing surface (identical wire output either way; only wall time changes).
 */
export const PHOENIX_PANO_STAMP_WAVE = "phoenix-pano-stamp-wave";

/**
 * mecmua write-path dark-ship seam (#2497): `mecmua.publish` + `mecmua.saveDraft` fail
 * `MECMUA_DISABLED` with it off. Default-off, ADR 0083.
 */
export const MECMUA_WRITE = "mecmua-write";

/**
 * mecmua public-read dark-ship seam (#2498): the `GET /fate/mecmua/post/:slug` route's existence
 * (404 until flipped) AND the `/mecmua/:slug` reader page's self-404. Default-off, ADR 0083.
 */
export const MECMUA_PUBLIC_READ = "mecmua-public-read";

/**
 * mecmua subscribed-author feed dark-ship seam (#2500): the `mecmuaFeed` list root (empty when
 * off), the subscribe/unsubscribe mutations, AND the `/mecmua` feed page's self-404. Default-off,
 * ADR 0083.
 */
export const MECMUA_FEED = "mecmua-feed";

/**
 * The single seam for the WHOLE notification surface (#1694) — unread badge, `/bildirimler`, and
 * every emitter reuse this one key rather than minting per-child flags. Default-off, ADR 0083.
 */
export const PHOENIX_BILDIRIM = "phoenix-bildirim";

/**
 * The single cross-product seam for the WHOLE reaction feature (#1863) — the mutations and the
 * `reactions` view field on every surface reuse this one key, so one flip releases it all.
 * Default-off, ADR 0083.
 */
export const PHOENIX_REACTIONS = "phoenix-reactions";

/**
 * The single seam for the karma-VALUE floors (#150): the post-floor (`karma ≥ −4`) and the
 * report-floor (`karma ≥ 50`); off ⇒ no karma read runs at all. Default-off, ADR 0083.
 *
 * Deliberately NOT the çaylak→yazar tier gates or the ADR 0098 moderation surface — these are
 * anti-abuse floors, not a second tier ladder, so nothing is double-gated (#150 rescope).
 */
export const PHOENIX_KARMA_GATES = "phoenix-karma-gates";

/**
 * The single seam for ban/unban (#970): the `user.banUser` / `user.unbanUser` mutations, the
 * `user.banState` read, and the moderator-UI controls. Off ⇒ the invisible `Denied`, so no session
 * is ever refused by an unreleased feature. Default-off, ADR 0083.
 */
export const PHOENIX_USER_BAN = "phoenix-user-ban";

/**
 * The single seam for the `Admin.over(platform)`-gated `user.setRole` mutation (#3522). Off ⇒ the
 * invisible `Denied`, so an unreleased role-grant can never mint a moderator. Default-off, ADR 0083.
 */
export const PHOENIX_USER_ROLE_ASSIGN = "phoenix-user-role-assign";

/**
 * The single seam for the admin failing-address surface (#2692): the `emailDelivery.mark` /
 * `emailDelivery.clear` mutations and the `emailDelivery.failing` roll-up read. Off ⇒ the
 * invisible `Denied`. Default-off, ADR 0083.
 */
export const PHOENIX_EMAIL_DELIVERY_ADMIN = "phoenix-email-delivery-admin";

/**
 * The seam for the user-facing failing-email notice (#2693): off ⇒ the membrane mount renders
 * nothing. Default-off, ADR 0083.
 */
export const PHOENIX_EMAIL_DELIVERY_NOTICE = "phoenix-email-delivery-notice";

/**
 * The single seam for the kullanıcılar roster READ view (#3200): the `userAdmin.list` resolver and
 * the console panel. The per-user actions (role-assign, ban/unban) ride their own seams.
 * Default-off, ADR 0083.
 */
export const PHOENIX_USER_ADMIN = "phoenix-user-admin";

/**
 * The single seam for the WHOLE profile canvas — read view (#3105), owner toggle (#3108),
 * paint/save (#3109) — rather than per-child flags, so one flip releases the mural.
 * Default-off, ADR 0083.
 */
export const PROFILE_CANVAS = "profile-canvas";

/**
 * The seam for the mute WRITE path (#3112): `mute.set` / `mute.remove` fail closed
 * (`MUTE_DISABLED`) with it off, so no member can mute another even if a client bypasses the UI.
 * The read-mask and the manage UI ship behind their own slices. Default-off, ADR 0083.
 */
export const MEMBER_MUTE = "member-mute";

export interface FlagDeclaration {
	readonly key: string;
	/** Mirrors `resources.ts`; every containment flag is off. */
	readonly defaultValue: boolean;
}

// The enumeration the flags console (#2742) renders a row per; the constants above stay the single
// home for the key strings, so the console can never name an undeclared flag.
export const DECLARED_FLAGS: readonly FlagDeclaration[] = [
	{key: PHOENIX_SOZLUK_STAMP_WAVE, defaultValue: false},
	{key: PHOENIX_PANO_STAMP_WAVE, defaultValue: false},
	{key: MECMUA_WRITE, defaultValue: false},
	{key: MECMUA_PUBLIC_READ, defaultValue: false},
	{key: MECMUA_FEED, defaultValue: false},
	{key: PHOENIX_BILDIRIM, defaultValue: false},
	{key: PHOENIX_REACTIONS, defaultValue: false},
	{key: PHOENIX_KARMA_GATES, defaultValue: false},
	{key: PHOENIX_USER_BAN, defaultValue: false},
	{key: PHOENIX_USER_ROLE_ASSIGN, defaultValue: false},
	{key: PHOENIX_EMAIL_DELIVERY_ADMIN, defaultValue: false},
	{key: PHOENIX_EMAIL_DELIVERY_NOTICE, defaultValue: false},
	{key: PHOENIX_USER_ADMIN, defaultValue: false},
	{key: PROFILE_CANVAS, defaultValue: false},
	{key: MEMBER_MUTE, defaultValue: false},
];
