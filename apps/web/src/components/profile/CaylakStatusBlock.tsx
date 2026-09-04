/**
 * `CaylakStatusBlock` — the çaylak's own "yazarlığa giden yol" status block on their
 * OWN profile, off the aggregate-only `myAuthorshipStanding` read.
 *
 * Fetched imperatively rather than through the suspending `useRequest`: the block
 * sits inside the header and must not suspend it on a secondary read, and must not
 * touch the wire at all unless the gates pass — `myAuthorshipStanding` throws
 * `UNAUTHORIZED` for an anonymous viewer.
 */
import {useId} from "react";
import {view} from "react-fate";
import type {AuthorshipStanding} from "../../../worker/features/fate/views";
import type {Tier} from "../../../worker/features/kunye/standing";
import {useMe} from "../../auth/useMe";
import {useImperativeView} from "../../fate/useImperativeView";
import {type CatalogKey, useT} from "../../i18n";
import {Karma} from "../karma/Karma";
import "./CaylakStatusBlock.css";

export function shouldShowCaylakStatus(tier: Tier | undefined, isOwnProfile: boolean): boolean {
	return tier === "çaylak" && isOwnProfile;
}

export function vouchExistsLabelKey(vouchExists: boolean): CatalogKey {
	return vouchExists ? "profile.caylakStatus.vouch.yes" : "profile.caylakStatus.vouch.no";
}

export const VOUCH_NEEDED_KEYS = {
	message: "profile.caylakStatus.vouchNeeded.message",
	hint: "profile.caylakStatus.vouchNeeded.hint",
} as const satisfies Record<"message" | "hint", CatalogKey>;

/**
 * An unvouched çaylak deliberately gets NO karma bar: `resolveTandem` short-circuits
 * on the vouch half, so no amount of karma promotes them and the unassisted 100-bar
 * would depict a goal that maps to no live promotion trigger (#1323). Only once a
 * vouch exists is there an honest bar to draw (the reduced `VOUCH_PROMOTION_KARMA_BAR`
 * = 15).
 */
export type CaylakPromotionPath =
	| {readonly kind: "karma-bar"}
	| {readonly kind: "vouch-needed"; readonly messageKey: CatalogKey; readonly hintKey: CatalogKey};

export function caylakPromotionPath(vouchExists: boolean): CaylakPromotionPath {
	return vouchExists
		? {kind: "karma-bar"}
		: {
				kind: "vouch-needed",
				messageKey: VOUCH_NEEDED_KEYS.message,
				hintKey: VOUCH_NEEDED_KEYS.hint,
			};
}

/**
 * One-way glass: the `id` normalization key plus the four aggregate scalars, and
 * deliberately NO reviewer / voter / voucher identity key. The invariant is
 * structural on the backend type (#1316) and mirrored here, so widening this
 * selection is what would reintroduce the leak.
 */
export const STANDING_FIELDS = {
	id: true,
	karma: true,
	bar: true,
	vouchExists: true,
	inReviewCount: true,
} as const;

const StandingView = view<AuthorshipStanding>()(STANDING_FIELDS);

// See ADR 0022
type Standing = Pick<AuthorshipStanding, "karma" | "bar" | "vouchExists" | "inReviewCount">;

// A failed read resolves to `null` on purpose — the safe/off path, so an error
// degrades to "no block" rather than throwing the whole header.
//
// Exported for `WelcomePage` (#7043): the welcome surface reads the SAME view selection
// through this one hook rather than growing a second `myAuthorshipStanding` read.
export function useAuthorshipStanding(enabled: boolean): Standing | null {
	const {state} = useImperativeView("myAuthorshipStanding", StandingView, {enabled});
	return state.status === "ok" ? state.data : null;
}

export interface CaylakStatusBlockProps {
	readonly profileUserId: string;
}

export function CaylakStatusBlock({profileUserId}: CaylakStatusBlockProps) {
	const {me} = useMe();
	const t = useT();
	const headingId = useId();
	const show = shouldShowCaylakStatus(me?.tier, me?.id === profileUserId);
	const standing = useAuthorshipStanding(show);

	if (!show || !standing) return null;

	const path = caylakPromotionPath(standing.vouchExists);

	return (
		<section
			className="kp-caylak-status"
			aria-labelledby={headingId}
			data-testid="caylak-status-block"
		>
			<h2 id={headingId} className="kp-caylak-status__heading">
				{t("profile.caylakStatus.heading")}
			</h2>
			{path.kind === "karma-bar" ? (
				<div className="kp-caylak-status__karma">
					<Karma value={standing.karma} target={standing.bar} testId="caylak-status-karma" />
				</div>
			) : (
				<div className="kp-caylak-status__vouch-needed" data-testid="caylak-status-vouch-needed">
					<p className="kp-caylak-status__vouch-message">{t(path.messageKey)}</p>
					<p className="kp-caylak-status__vouch-hint">{t(path.hintKey)}</p>
				</div>
			)}
			<dl className="kp-caylak-status__facts">
				<div className="kp-caylak-status__fact">
					<dt className="kp-caylak-status__term">{t("profile.caylakStatus.term.kefil")}</dt>
					<dd className="kp-caylak-status__value" data-testid="caylak-status-vouch">
						{t(vouchExistsLabelKey(standing.vouchExists))}
					</dd>
				</div>
				<div className="kp-caylak-status__fact">
					<dt className="kp-caylak-status__term">{t("profile.caylakStatus.term.inReview")}</dt>
					<dd className="kp-caylak-status__value" data-testid="caylak-status-in-review">
						{standing.inReviewCount}
					</dd>
				</div>
			</dl>
		</section>
	);
}
