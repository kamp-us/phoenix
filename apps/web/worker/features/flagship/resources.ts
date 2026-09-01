/**
 * The Flagship flag-IaC surface — the `Flagship` app and every flag declaration (ADR 0081).
 * Flags are declared in-stack, not on the dashboard; which flags are IaC vs dashboard-managed
 * and the sanctioned rule taxonomy live in
 * [.patterns/feature-flags-targeting.md](../../../../../.patterns/feature-flags-targeting.md).
 */
import type {Input} from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import {
	MECMUA_FEED,
	MECMUA_PUBLIC_READ,
	MECMUA_WRITE,
	MEMBER_MUTE,
	PHOENIX_BILDIRIM,
	PHOENIX_CAYLAK_METER,
	PHOENIX_CAYLAK_VISIBILITY,
	PHOENIX_EMAIL_DELIVERY_ADMIN,
	PHOENIX_EMAIL_DELIVERY_NOTICE,
	PHOENIX_FUNNEL_COHORT,
	PHOENIX_KARMA_GATES,
	PHOENIX_PANO_STAMP_WAVE,
	PHOENIX_REACTIONS,
	PHOENIX_SOZLUK_STAMP_WAVE,
	PHOENIX_USER_ADMIN,
	PHOENIX_USER_BAN,
	PHOENIX_USER_ROLE_ASSIGN,
	PHOENIX_WELCOME,
	PROFILE_CANVAS,
} from "../../../src/flags/keys.ts";

export const Flagship = Cloudflare.Flagship.App("phoenix_flags", {});

/**
 * Rules evaluate in ascending `priority`, first match wins: the `internal` role gets `on`
 * outright, then 25% of the rest by consistent hash on `targetingKey`.
 *
 * A factory, not a module constant: `appId` is an alchemy `Input`/`Output` resolved at deploy,
 * so it only exists once the stack has yielded the app resource. Every flag factory below is a
 * factory for this same reason.
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
 * Every flag config below is exported as a plain object so the default-=-safe-state invariant
 * is unit-inspectable WITHOUT constructing the alchemy resource; the factory spreads it into
 * `FlagshipFlag`. Default-OFF ships the path to production dark — flipping it on is the human
 * release act (ADR 0083).
 */
export const MECMUA_WRITE_FLAG = {
	key: MECMUA_WRITE,
	description:
		"mecmua write-path (publish + save-draft) dark-ship (#2497, epic #2467). owner: mecmua. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

export const mecmuaWriteFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("mecmua_write", {appId, ...MECMUA_WRITE_FLAG});

export const MECMUA_FEED_FLAG = {
	key: MECMUA_FEED,
	description:
		"mecmua subscribed-author feed (mecmuaFeed root + subscribe/unsubscribe + feed page) dark-ship (#2500, epic #2467). owner: mecmua. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

export const mecmuaFeedFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("mecmua_feed", {appId, ...MECMUA_FEED_FLAG});

export const BILDIRIM_FLAG = {
	key: PHOENIX_BILDIRIM,
	description:
		"bildirim (notification system) dark-ship (#1694, epic #1666). owner: bildirim. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

export const bildirimFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_bildirim", {appId, ...BILDIRIM_FLAG});

export const REACTIONS_FLAG = {
	key: PHOENIX_REACTIONS,
	description:
		"emoji reactions (tepki) dark-ship (#1863, epic #1840). owner: reaction. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

export const reactionsFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_reactions", {appId, ...REACTIONS_FLAG});

/**
 * A separate axis from the çaylak→yazar tier gating and the mod-queue flag (ADR 0098): these
 * are anti-abuse karma-VALUE floors, not a second tier ladder — no double-gating (#150).
 */
export const KARMA_GATES_FLAG = {
	key: PHOENIX_KARMA_GATES,
	description:
		"karma-gated privileges dark-ship (#150, epic #41). owner: künye. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

export const karmaGatesFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_karma_gates", {appId, ...KARMA_GATES_FLAG});

export const USER_BAN_FLAG = {
	key: PHOENIX_USER_BAN,
	description:
		"user ban/unban dark-ship (#970, epic #968). owner: pasaport. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

export const userBanFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_user_ban", {appId, ...USER_BAN_FLAG});

export const USER_ROLE_ASSIGN_FLAG = {
	key: PHOENIX_USER_ROLE_ASSIGN,
	description:
		"platform role assign dark-ship (#3522, ADR 0107). owner: pasaport. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

export const userRoleAssignFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_user_role_assign", {appId, ...USER_ROLE_ASSIGN_FLAG});

export const EMAIL_DELIVERY_ADMIN_FLAG = {
	key: PHOENIX_EMAIL_DELIVERY_ADMIN,
	description:
		"admin failing-address mark/clear + roll-up dark-ship (#2692, epic #2687). owner: pasaport. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

export const emailDeliveryAdminFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_email_delivery_admin", {appId, ...EMAIL_DELIVERY_ADMIN_FLAG});

// Its own key, not the #2692 admin seam: the user-facing notice releases separately.
export const EMAIL_DELIVERY_NOTICE_FLAG = {
	key: PHOENIX_EMAIL_DELIVERY_NOTICE,
	description:
		"failing-email membrane notice dark-ship (#2693, epic #2687). owner: pasaport. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

export const emailDeliveryNoticeFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_email_delivery_notice", {appId, ...EMAIL_DELIVERY_NOTICE_FLAG});

export const MECMUA_PUBLIC_READ_FLAG = {
	key: MECMUA_PUBLIC_READ,
	description:
		"mecmua public-read (anon GET route + reader page) dark-ship (#2498, epic #2467). owner: mecmua. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

export const mecmuaPublicReadFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("mecmua_public_read", {appId, ...MECMUA_PUBLIC_READ_FLAG});

// `on` passes `"unbounded"` to the sözlük read's stamp wave, `off` keeps `concurrency: 1`.
// Wire output is identical either way — only wall time changes.
export const SOZLUK_STAMP_WAVE_FLAG = {
	key: PHOENIX_SOZLUK_STAMP_WAVE,
	description:
		"sözlük parallel-stamp-wave read collapse dark-ship (#2709, epic #2567). owner: sözlük. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

export const sozlukStampWaveFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_sozluk_stamp_wave", {appId, ...SOZLUK_STAMP_WAVE_FLAG});

// The pano twin of `SOZLUK_STAMP_WAVE_FLAG`, on its own seam: `on` fans the thread/comment
// stamp wave out `"unbounded"`, `off` keeps it serial. Scoped to the thread read, not the feed.
export const PANO_STAMP_WAVE_FLAG = {
	key: PHOENIX_PANO_STAMP_WAVE,
	description:
		"pano parallel-stamp-wave read collapse dark-ship (#2710, epic #2567). owner: pano. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

export const panoStampWaveFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_pano_stamp_wave", {appId, ...PANO_STAMP_WAVE_FLAG});

export const USER_ADMIN_FLAG = {
	key: PHOENIX_USER_ADMIN,
	description:
		"gated user-roster read view dark-ship (#3200, admin epic). owner: user-admin. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

export const userAdminFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_user_admin", {appId, ...USER_ADMIN_FLAG});

export const PROFILE_CANVAS_FLAG = {
	key: PROFILE_CANVAS,
	description:
		"profile free-paint canvas (duvar) dark-ship (#3103, epic #2035). owner: pasaport. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

export const profileCanvasFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("profile_canvas", {appId, ...PROFILE_CANVAS_FLAG});

export const MEMBER_MUTE_FLAG = {
	key: MEMBER_MUTE,
	description:
		"member-mute (sustur) write path (mute.set / mute.remove) dark-ship (#3112, epic #2035). owner: mute. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

export const memberMuteFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("member_mute", {appId, ...MEMBER_MUTE_FLAG});

/**
 * The çaylak in-place visibility dark-ship flag config (#6421, epic #4306). The SINGLE
 * seam the whole vertical gates behind — the yazar opt-in preference read + its mutation,
 * the third viewer class the sandbox read masks grow (distinct from the moderator class),
 * the çaylak marker field on the content wire shape, and both client surfaces (the
 * settings toggle and the marker render). Default-OFF so the feature reaches production
 * dark and ADR 0206's containment wall behaves exactly as today; flipping it on is the
 * human release act (ADR 0083).
 *
 * Exported as a plain object so the default-=-safe-state invariant is unit-inspectable
 * WITHOUT constructing the alchemy resource (mirrors `MEMBER_MUTE_FLAG`).
 *
 * Per-flag metadata (`feature-flags-schema-lifecycle.md`):
 *   - owner:           künye (the çaylak/yazar authorship surface)
 *   - originating:     #6421 (epic: çaylak in-place visibility, #4306)
 *   - removal trigger: once çaylak in-place visibility graduates to on at 100% and stable
 *                      for one release, retire the flag and inline the now-permanent path.
 */
export const CAYLAK_VISIBILITY_FLAG = {
	key: PHOENIX_CAYLAK_VISIBILITY,
	description:
		"çaylak in-place visibility (yazar opt-in preference + third viewer class + çaylak marker + both client surfaces) dark-ship (#6421, epic #4306). owner: künye. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/**
 * A plain boolean kill-switch, no targeting rules. `appId` is resolved at deploy
 * (see `demoTargetingFlag` for why it's a factory, not a module constant).
 */
export const caylakVisibilityFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_caylak_visibility", {appId, ...CAYLAK_VISIBILITY_FLAG});

/**
 * The `/funnel` cohort-section display dark-ship seam (#7031, epic #6767): the single seam the
 * `funnel.cohorts` report, the live cohort-week list, the rollup-record list and the client
 * section gate behind. Default-OFF so the cohort DISPLAY ships dark independently of the
 * always-on `user_activity_day` capture (#7029) — founder ruling R1.2 on #7028 gates the
 * display separately from capture; flipping it on is the human release act (ADR 0083).
 *
 * Per-flag metadata (`feature-flags-schema-lifecycle.md`):
 *   - owner:           funnel (the moderation readout surface)
 *   - originating:     #7031 (epic: week-1 survival cohort funnel, #6767)
 *   - removal trigger: once the cohort section is on at 100% and stable for one release,
 *                      retire the flag and inline the now-permanent read.
 */
export const FUNNEL_COHORT_FLAG = {
	key: PHOENIX_FUNNEL_COHORT,
	description:
		"/funnel cohort-section display dark-ship (#7031, epic #6767). owner: funnel. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/** A plain boolean kill-switch, no targeting rules — see `caylakVisibilityFlag`. */
export const funnelCohortFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_funnel_cohort", {appId, ...FUNNEL_COHORT_FLAG});

/**
 * The welcome-arrival dark-ship flag config (#7043, epic #4304). The SINGLE seam the whole
 * slice gates behind: the post-auth redirect intercept in `App.tsx` and the `/hosgeldin`
 * welcome surface. Default-OFF so the arrival ships dark — with it off the post-signup
 * redirect behaves byte-for-byte as before; flipping it on is the human release act
 * (ADR 0083).
 *
 * Per-flag metadata (`feature-flags-schema-lifecycle.md`):
 *   - owner:           onboarding (the new-user arrival surface)
 *   - originating:     #7043 (epic: new-user onboarding, #4304)
 *   - removal trigger: once the welcome moment is on at 100% and stable for one release,
 *                      retire the flag and inline the intercept.
 */
export const WELCOME_FLAG = {
	key: PHOENIX_WELCOME,
	description:
		"welcome arrival — post-auth intercept + /hosgeldin surface dark-ship (#7043, epic #4304). owner: onboarding. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/** A plain boolean kill-switch, no targeting rules — see `caylakVisibilityFlag`. */
export const welcomeFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_welcome", {appId, ...WELCOME_FLAG});

/**
 * The ambient-çaylak-meter dark-ship flag config (#7045, epic #4304). The SINGLE seam the
 * topbar karma chip's promotion readout gates behind. Default-OFF so the meter ships dark —
 * with it off the chip renders byte-for-byte today's bare karma value for every tier;
 * flipping it on is the human release act (ADR 0083).
 *
 * Per-flag metadata (`feature-flags-schema-lifecycle.md`):
 *   - owner:           onboarding (the çaylak→yazar path surfaces)
 *   - originating:     #7045 (epic: new-user onboarding, #4304)
 *   - removal trigger: once the meter is on at 100% and stable for one release, retire the
 *                      flag and inline the chip.
 */
export const CAYLAK_METER_FLAG = {
	key: PHOENIX_CAYLAK_METER,
	description:
		"ambient çaylak meter — topbar karma chip promotion readout dark-ship (#7045, epic #4304). owner: onboarding. removal: retire once on at 100% and stable.",
	defaultVariation: "off",
	variations: {off: false, on: true},
} as const;

/** A plain boolean kill-switch, no targeting rules — see `caylakVisibilityFlag`. */
export const caylakMeterFlag = (appId: Input<string>) =>
	Cloudflare.Flagship.Flag("phoenix_caylak_meter", {appId, ...CAYLAK_METER_FLAG});
