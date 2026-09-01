/**
 * `CaylakStatusBlock` — the çaylak's own "yazarlığa giden yol" status block on their
 * OWN profile, off the aggregate-only `myAuthorshipStanding` read.
 *
 * Fetched imperatively rather than through the suspending `useRequest`: the block
 * sits inside the header and must not suspend it on a secondary read, and must not
 * touch the wire at all unless the gates pass — `myAuthorshipStanding` throws
 * `UNAUTHORIZED` for an anonymous viewer.
 */
import {createContext, useContext, useId} from "react";
import {view} from "react-fate";
import type {AuthorshipStanding} from "../../../worker/features/fate/views";
import type {Tier} from "../../../worker/features/kunye/standing";
import {useMe} from "../../auth/useMe";
import {useImperativeView} from "../../fate/useImperativeView";
import {Karma} from "../karma/Karma";
import "./CaylakStatusBlock.css";

export function shouldShowCaylakStatus(tier: Tier | undefined, isOwnProfile: boolean): boolean {
	return tier === "çaylak" && isOwnProfile;
}

export function vouchExistsLabel(vouchExists: boolean): string {
	return vouchExists ? "var" : "yok";
}

export const VOUCH_NEEDED_COPY = {
	message: "bir yazar sana kefil olmalı",
	hint: "ya da bir moderatör seni doğrudan yükseltebilir",
} as const;

/**
 * An unvouched çaylak deliberately gets NO karma bar: `resolveTandem` short-circuits
 * on the vouch half, so no amount of karma promotes them and the unassisted 100-bar
 * would depict a goal that maps to no live promotion trigger (#1323). Only once a
 * vouch exists is there an honest bar to draw (the reduced `VOUCH_PROMOTION_KARMA_BAR`
 * = 15).
 */
export type CaylakPromotionPath =
	| {readonly kind: "karma-bar"}
	| {readonly kind: "vouch-needed"; readonly message: string; readonly hint: string};

export function caylakPromotionPath(vouchExists: boolean): CaylakPromotionPath {
	return vouchExists
		? {kind: "karma-bar"}
		: {kind: "vouch-needed", message: VOUCH_NEEDED_COPY.message, hint: VOUCH_NEEDED_COPY.hint};
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
export type Standing = Pick<AuthorshipStanding, "karma" | "bar" | "vouchExists" | "inReviewCount">;

// A failed read resolves to `null` on purpose — the safe/off path, so an error
// degrades to "no block" rather than throwing the whole header.
//
// Exported for `WelcomePage` (#7043): the welcome surface reads the SAME view selection
// through this one hook rather than growing a second `myAuthorshipStanding` read.
export function useAuthorshipStanding(enabled: boolean): Standing | null {
	const {state} = useImperativeView("myAuthorshipStanding", StandingView, {enabled});
	return state.status === "ok" ? state.data : null;
}

/**
 * `null` ⇒ nothing upstream holds a standing read, so a consumer below issues its own.
 * Non-null ⇒ the chrome's ambient meter is already reading this view (its `standing` may still
 * be settling), so a read here would duplicate a request rather than fetch a second fact.
 */
export type AuthorshipStandingChannel = {readonly standing: Standing | null} | null;

export const AuthorshipStandingContext = createContext<AuthorshipStandingChannel>(null);

/**
 * The standing read for a consumer below the chrome. `useImperativeView` has no dedupe — every
 * instance fires its own `fate.request` in an effect — so `enabled` is ANDed with "nothing
 * upstream is reading": two live requests for one view are unreachable, not merely untested.
 */
export function useSharedAuthorshipStanding(enabled: boolean): Standing | null {
	const upstream = useContext(AuthorshipStandingContext);
	const own = useAuthorshipStanding(enabled && upstream === null);
	return upstream ? upstream.standing : own;
}

export interface CaylakStatusBlockProps {
	readonly profileUserId: string;
}

export function CaylakStatusBlock({profileUserId}: CaylakStatusBlockProps) {
	const {me} = useMe();
	const headingId = useId();
	const show = shouldShowCaylakStatus(me?.tier, me?.id === profileUserId);
	const standing = useSharedAuthorshipStanding(show);

	if (!show || !standing) return null;

	const path = caylakPromotionPath(standing.vouchExists);

	return (
		<section
			className="kp-caylak-status"
			aria-labelledby={headingId}
			data-testid="caylak-status-block"
		>
			<h2 id={headingId} className="kp-caylak-status__heading">
				yazarlığa giden yol
			</h2>
			{path.kind === "karma-bar" ? (
				<div className="kp-caylak-status__karma">
					<Karma
						value={standing.karma}
						target={standing.bar}
						label="karma"
						testId="caylak-status-karma"
					/>
				</div>
			) : (
				<div className="kp-caylak-status__vouch-needed" data-testid="caylak-status-vouch-needed">
					<p className="kp-caylak-status__vouch-message">{path.message}</p>
					<p className="kp-caylak-status__vouch-hint">{path.hint}</p>
				</div>
			)}
			<dl className="kp-caylak-status__facts">
				<div className="kp-caylak-status__fact">
					<dt className="kp-caylak-status__term">kefil</dt>
					<dd className="kp-caylak-status__value" data-testid="caylak-status-vouch">
						{vouchExistsLabel(standing.vouchExists)}
					</dd>
				</div>
				<div className="kp-caylak-status__fact">
					<dt className="kp-caylak-status__term">incelemede</dt>
					<dd className="kp-caylak-status__value" data-testid="caylak-status-in-review">
						{standing.inReviewCount}
					</dd>
				</div>
			</dl>
		</section>
	);
}
