/**
 * The Flagship flag-IaC surface — the `Flagship` app and every flag declaration,
 * homed beside their evaluator (`Flags.ts`/`Flagship.ts`) instead of in
 * `db/resources.ts` (ADR 0081, epic #488). The alchemy stack (`alchemy.run.ts`)
 * `bind()`s the app and yields the flag factories; the worker `bind()`s the app
 * in init. Declared in-stack (not on the Flagship dashboard) so each rule is
 * reproducible and reviewable — see
 * [.patterns/feature-flags-targeting.md](../../../../../.patterns/feature-flags-targeting.md)
 * for which flags are IaC vs dashboard-managed and the sanctioned rule taxonomy.
 */
import type {Input} from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import {
	MECMUA_FEED,
	MECMUA_PUBLIC_READ,
	MECMUA_WRITE,
	MEMBER_MUTE,
	PHOENIX_BILDIRIM,
	PHOENIX_EDGE_SHELL_BOOT,
	PHOENIX_EMAIL_DELIVERY_ADMIN,
	PHOENIX_EMAIL_DELIVERY_NOTICE,
	PHOENIX_KARMA_GATES,
	PHOENIX_PANO_STAMP_WAVE,
	PHOENIX_REACTIONS,
	PHOENIX_SOZLUK_STAMP_WAVE,
	PHOENIX_USER_ADMIN,
	PHOENIX_USER_BAN,
	PHOENIX_USER_ROLE_ASSIGN,
	PROFILE_CANVAS,
} from "../../../src/flags/keys.ts";

/**
 * The Cloudflare Flagship app — the container the worker's feature flags live in
 * (epic #488). Alchemy provisions it on deploy and assigns the `appId`; there is
 * no dashboard step. The worker `bind()`s it in init (see `Flagship.ts`) to
 * resolve a typed Effect-native `FlagshipClient`.
 */
export const Flagship = Cloudflare.Flagship.App("phoenix_flags", {});

/**
 * The IaC-declared demo flag for targeting + percentage rollout (epic #488,
 * #511).
 *
 * Two rules, evaluated in ascending `priority` (first match wins):
 *   1. an attribute-targeting rule — any request whose `roles` carries the
 *      `internal` role gets `on` outright (the named-subset release);
 *   2. a consistent-hash percentage rollout — 25% of the remaining users, bucketed
 *      stably on `targetingKey` (the request's `userId`), get `on`.
 * Everyone else falls through to `defaultVariation: "off"`.
 *
 * `appId` is the app's server-generated id, available only once the app resource
 * is yielded in the stack — hence a factory the stack calls with `app.appId`
 * (an alchemy `Input<string>`/`Output`, resolved at deploy), not a module-scope
 * constant (the app attribute isn't resolved at import).
 */
export const DEMO_TARGETING_FLAG_KEY = "phoenix-flags-targeting-demo";
export const DEMO_TARGETING_INTERNAL_ROLE = "internal";

export const demoTargetingFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_flags_targeting_demo", {
		appId,
		key: DEMO_TARGETING_FLAG_KEY,
		description:
			"Epic #488/#511 demo: internal-role targeting + 25% consistent-hash rollout on userId.",
		defaultVariation: "off",
		variations: {off: false, on: true},
		rules: [
			{
				priority: 1,
				conditions: [
					{
						attribute: "roles",
						operator: "contains",
						value: `|${DEMO_TARGETING_INTERNAL_ROLE}|`,
					},
				],
				serveVariation: "on",
			},
			{
				priority: 2,
				conditions: [],
				serveVariation: "on",
				rollout: {percentage: 25},
			},
		],
	});

export {PHOENIX_BILDIRIM, PHOENIX_KARMA_GATES};

/**
 * The mecmua write-path dark-ship flag config (#2497, epic #2467). The SINGLE seam
 * the mecmua write surface gates behind — `mecmua.publish` + `mecmua.saveDraft` fail
 * `MECMUA_DISABLED` with it off, so the write path reaches production dark; flipping
 * it on is the human release act (ADR 0083).
 *
 * Exported as a plain object so the default-=-safe-state invariant is unit-inspectable
 * WITHOUT constructing the alchemy resource: the factory spreads it into `FlagshipFlag`;
 * the test asserts `defaultVariation`/`variations.off` on this same record. Every flag
 * config below is exported the same way for the same reason.
 *
 * Per-flag metadata (`.patterns/feature-flags-schema-lifecycle.md`):
 *   - owner:           mecmua
 *   - originating:     #2497 (epic: mecmua v1 post feature, #2467)
 *   - removal trigger: once the mecmua write path is on at 100% and stable for one
 *                      release, retire the flag and delete its gate.
 */
export const MECMUA_WRITE_FLAG = {
	key: MECMUA_WRITE,
	description:
		"mecmua write-path (publish + save-draft) dark-ship (#2497, epic #2467). owner: mecmua. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * No targeting rules — a plain boolean kill-switch. `appId` is resolved at deploy.
 */
export const mecmuaWriteFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("mecmua_write", {appId, ...MECMUA_WRITE_FLAG});

/**
 * The mecmua subscribed-author feed dark-ship flag config (#2500, epic #2467). The
 * SINGLE seam the feed surface gates behind — the `mecmuaFeed` list root (empty when
 * off), the `mecmua.subscribe` / `mecmua.unsubscribe` mutations, and the `/mecmua` feed
 * page. Default-OFF so the whole feed path reaches production dark; flipping it on is the
 * human release act (ADR 0083).
 *
 * Exported as a plain object so the default-=-safe-state invariant is unit-inspectable
 * WITHOUT constructing the alchemy resource (mirrors `MECMUA_WRITE_FLAG`).
 *
 * Per-flag metadata (`.patterns/feature-flags-schema-lifecycle.md`):
 *   - owner:           mecmua (the long-form feed surface)
 *   - originating:     #2500 (epic: mecmua v1 post feature, #2467)
 *   - removal trigger: once the mecmua feed is on at 100% and stable for one release,
 *                      retire the flag and inline the feed root + page.
 */
export const MECMUA_FEED_FLAG = {
	key: MECMUA_FEED,
	description:
		"mecmua subscribed-author feed (mecmuaFeed root + subscribe/unsubscribe + feed page) dark-ship (#2500, epic #2467). owner: mecmua. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * A plain boolean kill-switch, no targeting rules. `appId` is resolved at deploy
 * (mirrors `mecmuaWriteFlag`).
 */
export const mecmuaFeedFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("mecmua_feed", {appId, ...MECMUA_FEED_FLAG});

/**
 * The bildirim (notification system) dark-ship flag config (#1694, epic #1666).
 * The SINGLE seam the whole notification surface gates behind: the spine's badge +
 * center page and each sibling emitter's surface (#1695–#1700) reuse this one key
 * rather than minting per-child flags. Default-OFF so the system reaches production
 * dark — with it off, nothing user-visible changes (the resolvers deny invisibly,
 * the badge and `/bildirimler` route are absent); flipping it on is the human
 * release act (ADR 0083).
 *
 * Exported as a plain object so the default-=-safe-state invariant is
 * unit-inspectable WITHOUT constructing the alchemy resource (mirrors
 * `MECMUA_WRITE_FLAG`).
 *
 * Per-flag metadata (the IaC ownership record `feature-flags-schema-lifecycle.md`
 * asks for):
 *   - owner:           bildirim (the notification system, epic #1666)
 *   - originating:     #1694 (the bildirim spine)
 *   - removal trigger: once the notification system is on at 100% and stable for
 *                      one release, retire the flag and inline the surface.
 */
export const BILDIRIM_FLAG = {
	key: PHOENIX_BILDIRIM,
	description:
		"bildirim (notification system) dark-ship (#1694, epic #1666). owner: bildirim. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * A plain boolean kill-switch, no targeting rules. `appId` is resolved at deploy
 * (see `demoTargetingFlag` for why it's a factory, not a module constant).
 */
export const bildirimFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_bildirim", {appId, ...BILDIRIM_FLAG});

/**
 * The reactions (emoji tepki) dark-ship flag config (#1863, epic #1840). The
 * SINGLE seam the whole reaction feature gates behind — the react/change/retract
 * mutations plus the `reactions` view field on pano post/comment + sözlük
 * definition reuse this one cross-cutting key rather than minting a per-surface
 * flag. Default-OFF so the ungated social-signal affordance reaches production dark
 * (the product behaves exactly as today, no reaction surface); flipping it on is
 * the human release act (ADR 0083).
 *
 * Exported as a plain object so the default-=-safe-state invariant is
 * unit-inspectable WITHOUT constructing the alchemy resource (mirrors
 * `MECMUA_WRITE_FLAG`).
 *
 * Per-flag metadata (the IaC ownership record `feature-flags-schema-lifecycle.md`
 * asks for):
 *   - owner:           reaction (the karma-free, ungated social-signal engine)
 *   - originating:     #1863 (epic: emoji reactions, #1840)
 *   - removal trigger: once reactions graduate to on at 100% and stable for one
 *                      release, retire the flag and inline the now-permanent path.
 */
export const REACTIONS_FLAG = {
	key: PHOENIX_REACTIONS,
	description:
		"emoji reactions (tepki) dark-ship (#1863, epic #1840). owner: reaction. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * A plain boolean kill-switch, no targeting rules. `appId` is resolved at deploy
 * (see `demoTargetingFlag` for why it's a factory, not a module constant).
 */
export const reactionsFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_reactions", {appId, ...REACTIONS_FLAG});

/**
 * The karma-gated privileges dark-ship flag config (#150, künye epic #41). The
 * SINGLE seam the karma-VALUE privilege gates ride behind — the post-floor
 * (`karma ≥ −4`, on pano post/comment + sözlük definition creation) and the
 * flag-floor (`karma ≥ 50`, on `report.submit`). Default-OFF so the gates reach
 * production dark: with it off the karma read never runs and every write behaves
 * exactly as today; flipping it on is the human release act (ADR 0083).
 *
 * A separate axis from the çaylak→yazar tier gating and the mod-queue flag (ADR
 * 0098 moderation) — these are anti-abuse karma-value floors, not a second tier
 * ladder (no double-gating, #150 rescope 2026-07-02).
 *
 * Exported as a plain object so the default-=-safe-state invariant is
 * unit-inspectable WITHOUT constructing the alchemy resource (mirrors
 * `REACTIONS_FLAG`).
 *
 * Per-flag metadata (`feature-flags-schema-lifecycle.md`):
 *   - owner:           künye (the earned-standing / privilege surface)
 *   - originating:     #150 (epic: künye reputation, #41)
 *   - removal trigger: once the karma gates graduate to on at 100% and stable for
 *                      one release, retire the flag and inline the now-permanent gate.
 */
export const KARMA_GATES_FLAG = {
	key: PHOENIX_KARMA_GATES,
	description:
		"karma-gated privileges dark-ship (#150, epic #41). owner: künye. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * A plain boolean kill-switch, no targeting rules. `appId` is resolved at deploy
 * (see `demoTargetingFlag` for why it's a factory, not a module constant).
 */
export const karmaGatesFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_karma_gates", {appId, ...KARMA_GATES_FLAG});

/**
 * The user ban/unban dark-ship flag config (#970, admin epic #968). The SINGLE seam
 * the ban surface gates behind — the `user.banUser` / `user.unbanUser` admin
 * mutations, the `user.banState` admin read, and the moderator-UI ban controls.
 * Default-OFF so the whole ban path reaches production dark: with it off the
 * mutations/read fail the invisible `Denied` and the client controls render nothing,
 * so an unreleased feature can never refuse a real user's session. Flipping it on is
 * the human release act (ADR 0083).
 *
 * Exported as a plain object so the default-=-safe-state invariant is
 * unit-inspectable WITHOUT constructing the alchemy resource (mirrors `MECMUA_WRITE_FLAG`).
 *
 * Per-flag metadata (`feature-flags-schema-lifecycle.md`):
 *   - owner:           pasaport (the identity + session-boundary surface)
 *   - originating:     #970 (epic: admin dashboard, #968)
 *   - removal trigger: once ban graduates to on at 100% and stable for one release,
 *                      retire the flag and inline the now-permanent ban path.
 */
export const USER_BAN_FLAG = {
	key: PHOENIX_USER_BAN,
	description:
		"user ban/unban dark-ship (#970, epic #968). owner: pasaport. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * A plain boolean kill-switch, no targeting rules. `appId` is resolved at deploy
 * (see `demoTargetingFlag` for why it's a factory, not a module constant).
 */
export const userBanFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_user_ban", {appId, ...USER_BAN_FLAG});

/**
 * The platform-role assignment dark-ship flag config (#3522, admin epic per ADR 0107).
 * Default-OFF so the whole role-assign path reaches production dark: with it off the
 * `Admin.over(platform)`-gated `user.setRole` mutation fails the invisible `Denied` (like
 * a non-admin call), so an unreleased role-grant can never mint a moderator. Flipping it
 * on is the human release act (ADR 0083).
 *
 * Exported as a plain object so the default-=-safe-state invariant is unit-inspectable
 * WITHOUT constructing the alchemy resource (mirrors `USER_BAN_FLAG`).
 *
 * Per-flag metadata (`feature-flags-schema-lifecycle.md`):
 *   - owner:           pasaport (the identity + authority surface)
 *   - originating:     #3522 (epic: admin dashboard, per ADR 0107)
 *   - removal trigger: once role-assign graduates to on at 100% and stable for one
 *                      release, retire the flag and inline the now-permanent path.
 */
export const USER_ROLE_ASSIGN_FLAG = {
	key: PHOENIX_USER_ROLE_ASSIGN,
	description:
		"platform role assign dark-ship (#3522, ADR 0107). owner: pasaport. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * A plain boolean kill-switch, no targeting rules. `appId` is resolved at deploy
 * (see `demoTargetingFlag` for why it's a factory, not a module constant).
 */
export const userRoleAssignFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_user_role_assign", {appId, ...USER_ROLE_ASSIGN_FLAG});

/**
 * The admin email-delivery (failing-address) surface dark-ship flag config (#2692,
 * email-bounce epic #2687). Default-OFF so the whole admin path reaches production dark:
 * with it off the `emailDelivery.mark` / `emailDelivery.clear` mutations and the
 * `emailDelivery.failing` roll-up read fail the invisible `Denied` (like a non-admin
 * call), so no manual failing-mark or roll-up leaks. Flipping it on is the human release
 * act (ADR 0083).
 *
 * Exported as a plain object so the default-=-safe-state invariant is unit-inspectable
 * WITHOUT constructing the alchemy resource (mirrors `USER_BAN_FLAG`).
 *
 * Per-flag metadata (`feature-flags-schema-lifecycle.md`):
 *   - owner:           pasaport (the identity + email-delivery surface)
 *   - originating:     #2692 (epic: email-bounce, #2687)
 *   - removal trigger: once the admin failing-address surface graduates to on at 100%
 *                      and stable for one release, retire the flag and inline the path.
 */
export const EMAIL_DELIVERY_ADMIN_FLAG = {
	key: PHOENIX_EMAIL_DELIVERY_ADMIN,
	description:
		"admin failing-address mark/clear + roll-up dark-ship (#2692, epic #2687). owner: pasaport. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * A plain boolean kill-switch, no targeting rules. `appId` is resolved at deploy
 * (see `demoTargetingFlag` for why it's a factory, not a module constant).
 */
export const emailDeliveryAdminFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_email_delivery_admin", {appId, ...EMAIL_DELIVERY_ADMIN_FLAG});

/**
 * The failing-email membrane notice dark-ship flag config (#2693, email-bounce epic
 * #2687). The seam the user-facing notice gates behind — with it off the membrane mount
 * renders nothing, so the surface ships dark until a human flips it at release (ADR 0083).
 * Its OWN key, not the admin seam (#2692): the user-facing notice is a distinct surface
 * from the admin failing-address console, with its own release lifecycle.
 *
 * Exported as a plain object so the default-=-safe-state invariant is unit-inspectable
 * WITHOUT constructing the alchemy resource (mirrors `EMAIL_DELIVERY_ADMIN_FLAG`).
 *
 * Per-flag metadata (`feature-flags-schema-lifecycle.md`):
 *   - owner:           pasaport (the identity + email-delivery surface)
 *   - originating:     #2693 (epic: email-bounce, #2687)
 *   - removal trigger: once the notice graduates to on at 100% and stable for one
 *                      release, retire the flag and inline the membrane mount.
 */
export const EMAIL_DELIVERY_NOTICE_FLAG = {
	key: PHOENIX_EMAIL_DELIVERY_NOTICE,
	description:
		"failing-email membrane notice dark-ship (#2693, epic #2687). owner: pasaport. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * A plain boolean kill-switch, no targeting rules. `appId` is resolved at deploy
 * (see `demoTargetingFlag` for why it's a factory, not a module constant).
 */
export const emailDeliveryNoticeFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_email_delivery_notice", {appId, ...EMAIL_DELIVERY_NOTICE_FLAG});

/**
 * The mecmua public-read dark-ship flag config (#2498, epic #2467). The SINGLE seam
 * the anonymous read surface gates behind — the `GET /fate/mecmua/post/:slug` route
 * (404 until flipped) + the `/mecmua/:slug` reader page (self-404). Default-OFF so
 * the whole public-read path reaches production dark: with it off the route 404s and
 * the page renders the 404, so no unpublished-feature surface is reachable; flipping
 * it on is the human release act (ADR 0083). Its own `mecmua-` key, scoped to reads —
 * the authoring/publish path (#2497) ships behind its own seam.
 *
 * Exported as a plain object so the default-=-safe-state invariant is unit-inspectable
 * WITHOUT constructing the alchemy resource (mirrors `MECMUA_WRITE_FLAG`).
 *
 * Per-flag metadata (`feature-flags-schema-lifecycle.md`):
 *   - owner:           mecmua (the long-form read surface)
 *   - originating:     #2498 (epic: mecmua, #2467)
 *   - removal trigger: once mecmua public read graduates to on at 100% and stable for
 *                      one release, retire the flag and inline the route + page.
 */
export const MECMUA_PUBLIC_READ_FLAG = {
	key: MECMUA_PUBLIC_READ,
	description:
		"mecmua public-read (anon GET route + reader page) dark-ship (#2498, epic #2467). owner: mecmua. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * A plain boolean kill-switch, no targeting rules. `appId` is resolved at deploy
 * (see `demoTargetingFlag` for why it's a factory, not a module constant).
 */
export const mecmuaPublicReadFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("mecmua_public_read", {appId, ...MECMUA_PUBLIC_READ_FLAG});

/**
 * The sözlük parallel-stamp-wave containment flag config (#2709, epic #2567).
 * Default-OFF so the read-path collapse reaches production dark: with it off the
 * sözlük definition reads run their stamp wave at `concurrency: 1` (serial, exactly
 * today); flipping it on passes `"unbounded"` so the independent stamps fan out into
 * one concurrent wave. Wire output is identical either way — only wall time changes.
 * Flipping it on is the human release act (ADR 0083).
 *
 * Exported as a plain object so the default-=-safe-state invariant is unit-inspectable
 * WITHOUT constructing the alchemy resource (mirrors `MECMUA_WRITE_FLAG`).
 *
 * Per-flag metadata (`feature-flags-schema-lifecycle.md`):
 *   - owner:           sözlük (the definition read path)
 *   - originating:     #2709 (epic: collapse the serial stamp chain, #2567)
 *   - removal trigger: once the wave graduates to on at 100% and stable for one
 *                      release, retire the flag and inline `"unbounded"`.
 */
export const SOZLUK_STAMP_WAVE_FLAG = {
	key: PHOENIX_SOZLUK_STAMP_WAVE,
	description:
		"sözlük parallel-stamp-wave read collapse dark-ship (#2709, epic #2567). owner: sözlük. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * A plain boolean kill-switch, no targeting rules. `appId` is resolved at deploy
 * (see `demoTargetingFlag` for why it's a factory, not a module constant).
 */
export const sozlukStampWaveFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_sozluk_stamp_wave", {appId, ...SOZLUK_STAMP_WAVE_FLAG});

/**
 * The pano parallel-stamp-wave containment flag config (#2710, epic #2567) — the pano
 * sibling of `SOZLUK_STAMP_WAVE_FLAG`, behind its own seam. Default-OFF so the read-path
 * collapse reaches production dark: with it off the pano thread/comment reads
 * (`getCommentsByIds` / `listCommentsKeyset`) run their stamp wave at `concurrency: 1`
 * (serial, exactly today); flipping it on passes `"unbounded"` so the independent stamps
 * fan out into one concurrent wave. Wire output is identical either way — only wall time
 * changes. Flipping it on is the human release act (ADR 0083). Scoped to the thread read,
 * not the pano feed (the #2322 base/overlay split).
 *
 * Exported as a plain object so the default-=-safe-state invariant is unit-inspectable
 * WITHOUT constructing the alchemy resource (mirrors `MECMUA_WRITE_FLAG`).
 *
 * Per-flag metadata (`feature-flags-schema-lifecycle.md`):
 *   - owner:           pano (the thread/comment read path)
 *   - originating:     #2710 (epic: collapse the serial stamp chain, #2567)
 *   - removal trigger: once the wave graduates to on at 100% and stable for one
 *                      release, retire the flag and inline `"unbounded"`.
 */
export const PANO_STAMP_WAVE_FLAG = {
	key: PHOENIX_PANO_STAMP_WAVE,
	description:
		"pano parallel-stamp-wave read collapse dark-ship (#2710, epic #2567). owner: pano. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * A plain boolean kill-switch, no targeting rules. `appId` is resolved at deploy
 * (see `demoTargetingFlag` for why it's a factory, not a module constant).
 */
export const panoStampWaveFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_pano_stamp_wave", {appId, ...PANO_STAMP_WAVE_FLAG});

/**
 * The kullanıcılar (user-roster) admin-console module dark-ship flag config (#3200, admin
 * epic). The SINGLE seam the gated user-list read view gates behind — the `userAdmin.list`
 * admin fate resolver AND the `kullanıcılar` console panel. Default-OFF so the whole roster
 * surface reaches production dark — with it off the server read fails the invisible `Denied`
 * (like a non-admin call) and the panel renders nothing; flipping it on is the human release
 * act (ADR 0083).
 *
 * Exported as a plain object so the default-=-safe-state invariant is unit-inspectable
 * WITHOUT constructing the alchemy resource (mirrors `MEMBER_MUTE_FLAG`).
 *
 * Per-flag metadata (`feature-flags-schema-lifecycle.md`):
 *   - owner:           user-admin (the gated user-roster surface, hosted by the console shell)
 *   - originating:     #3200 (admin epic; supersedes the shell half of #968)
 *   - removal trigger: once the roster + its per-user actions graduate to on at 100% and
 *                      stable for one release, retire the flag and inline the module.
 */
export const USER_ADMIN_FLAG = {
	key: PHOENIX_USER_ADMIN,
	description:
		"gated user-roster read view dark-ship (#3200, admin epic). owner: user-admin. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * A plain boolean kill-switch, no targeting rules. `appId` is resolved at deploy
 * (see `demoTargetingFlag` for why it's a factory, not a module constant).
 */
export const userAdminFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_user_admin", {appId, ...USER_ADMIN_FLAG});

/**
 * The edge-resolved shell-boot containment flag config (#2928, epic #2926, ADR 0179). The
 * SINGLE seam the whole worker-first shell render ships behind. Default-OFF so the edge-render
 * path reaches production dark: with it off the SPA HTML stays edge-direct byte-identical to
 * today (the `assets` binding serves it, the worker never touches HTML); flipping it on has the
 * worker render the shell per request and inject `window.__BOOT__`. Flipping it on is the human
 * release act (ADR 0083).
 *
 * Exported as a plain object so the default-=-safe-state invariant is unit-inspectable WITHOUT
 * constructing the alchemy resource (mirrors `MEMBER_MUTE_FLAG`).
 *
 * Per-flag metadata (`feature-flags-schema-lifecycle.md`):
 *   - owner:           edge-shell (the worker-first shell render, epic #2926)
 *   - originating:     #2928 (epic: edge-resolved shell state, #2926)
 *   - removal trigger: once the edge shell render graduates to on at 100% and stable for one
 *                      release, retire the flag and inline the worker-first render.
 */
export const EDGE_SHELL_BOOT_FLAG = {
	key: PHOENIX_EDGE_SHELL_BOOT,
	description:
		"edge-resolved shell-boot (worker-first shell render + __BOOT__ injection) dark-ship (#2928, epic #2926, ADR 0179). owner: edge-shell. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * A plain boolean kill-switch, no targeting rules. `appId` is resolved at deploy
 * (see `demoTargetingFlag` for why it's a factory, not a module constant).
 */
export const edgeShellBootFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_edge_shell_boot", {appId, ...EDGE_SHELL_BOOT_FLAG});

/**
 * The profile free-paint canvas (duvar) dark-ship flag config (#3103, epic #2035). The
 * SINGLE seam the whole profile-canvas feature gates behind — the fate read view + visitor
 * render (#3105), the owner enable/toggle mutation (#3108), and the paint/save surface
 * (#3109). Default-OFF so the whole feature reaches production dark: with it off no canvas
 * surface renders and the owner-only mutations fail `CANVAS_DISABLED`, so the profile is
 * exactly as today; flipping it on is the human release act (ADR 0083).
 *
 * Exported as a plain object so the default-=-safe-state invariant is unit-inspectable
 * WITHOUT constructing the alchemy resource (mirrors `EDGE_SHELL_BOOT_FLAG`).
 *
 * Per-flag metadata (`feature-flags-schema-lifecycle.md`):
 *   - owner:           pasaport (the profile surface)
 *   - originating:     #3103 (epic: free-paint canvas space, #2035)
 *   - removal trigger: once the profile canvas graduates to on at 100% and stable for one
 *                      release, retire the flag and inline the now-permanent path.
 */
export const PROFILE_CANVAS_FLAG = {
	key: PROFILE_CANVAS,
	description:
		"profile free-paint canvas (duvar) dark-ship (#3103, epic #2035). owner: pasaport. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * A plain boolean kill-switch, no targeting rules. `appId` is resolved at deploy
 * (see `demoTargetingFlag` for why it's a factory, not a module constant).
 */
export const profileCanvasFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("profile_canvas", {appId, ...PROFILE_CANVAS_FLAG});

/**
 * The member-mute (sustur) write-path dark-ship flag config (#3112, epic #2035). The
 * SINGLE seam the mute write path gates behind — `mute.set` / `mute.remove` fail
 * `MUTE_DISABLED` with it off, so the whole primitive reaches production dark; flipping
 * it on is the human release act (ADR 0083). The read-mask (sibling) and the manage UI
 * (reachability child) ship behind their own slices.
 *
 * Exported as a plain object so the default-=-safe-state invariant is unit-inspectable
 * WITHOUT constructing the alchemy resource (mirrors `PROFILE_CANVAS_FLAG`).
 *
 * Per-flag metadata (`feature-flags-schema-lifecycle.md`):
 *   - owner:           mute (the member-mute relation surface)
 *   - originating:     #3112 (epic: free-paint canvas space / member-mute, #2035)
 *   - removal trigger: once member-mute graduates to on at 100% and stable for one
 *                      release, retire the flag and inline the now-permanent path.
 */
export const MEMBER_MUTE_FLAG = {
	key: MEMBER_MUTE,
	description:
		"member-mute (sustur) write path (mute.set / mute.remove) dark-ship (#3112, epic #2035). owner: mute. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * A plain boolean kill-switch, no targeting rules. `appId` is resolved at deploy
 * (see `demoTargetingFlag` for why it's a factory, not a module constant).
 */
export const memberMuteFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("member_mute", {appId, ...MEMBER_MUTE_FLAG});
