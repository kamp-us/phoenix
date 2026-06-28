/**
 * `CaylakStatusBlock` — the çaylak's own "yazarlığa giden yol" (path-to-authorship)
 * status block on their OWN profile (#1291, epic #1202). Reads the aggregate-only
 * `myAuthorshipStanding` (#1316): karma vs the promotion bar, whether a vouch
 * exists (a bare boolean — NEVER who vouched), and the count of entries in review.
 *
 * ONE-WAY GLASS — the load-bearing divan privacy invariant: the consumed shape is
 * aggregate-only and carries NO reviewer / voter / voucher identity. The field is
 * structurally absent on the backend `AuthorshipStanding` type (#1316), and this
 * surface selects only the four aggregate scalars ({@link STANDING_FIELDS}), so a
 * leak is unrepresentable at the API boundary AND here — never merely unrendered.
 *
 * Three gates, all required ({@link shouldShowCaylakStatus}): the
 * `phoenix-authorship-loop` flag (default-off, dark-ship — #1204/ADR 0083), the
 * trusted tier read off `useMe().me.tier` (#1297) being `çaylak`, AND the viewer
 * looking at their OWN profile (`me.id === profileUserId`). A yazar/mod, a visitor,
 * another user's profile, or a flag-off render is a clean no-op. The server also
 * returns `null` for `myAuthorshipStanding` when the flag is off (belt-and-suspenders),
 * and a null standing renders nothing — so the block never queries off the safe path.
 *
 * Honest promotion-path framing ({@link caylakPromotionPath}, #1323): an UNVOUCHED
 * çaylak does NOT see a karma progress bar — the unassisted bar is 100 but no amount
 * of karma promotes without a vouch (`resolveTandem` short-circuits on the vouch
 * half), so a 100-karma goal would depict a path that doesn't exist. The unvouched
 * state surfaces the vouch-needed framing instead; once `vouchExists` is true the
 * block draws the real reduced bar (15), the already-honest path.
 *
 * Imperative fetch (`request` + `readView`), not the suspending `useRequest`: the
 * block sits inside the header and must NOT suspend the whole header on a secondary
 * read, and must NOT query unless the three gates pass — the same reasoning as
 * `useMe`. `myAuthorshipStanding` throws `UNAUTHORIZED` for an anonymous viewer, so
 * gating on `me`/own-profile keeps a signed-out viewer off the wire.
 *
 * a11y: a labelled `<section>` region (`aria-labelledby` → its own heading) with a
 * real `<h2>`; vouch state is carried by words ("var"/"yok"), never color; the Karma
 * atom carries its own AA-contrast, reduced-motion-safe progress bar; no animation of
 * its own. Copy is lowercase Turkish (karma is a brand noun).
 */
import {useCallback, useEffect, useId, useState} from "react";
import {useFateClient, view} from "react-fate";
import type {AuthorshipStanding} from "../../../worker/features/fate/views";
import type {Tier} from "../../../worker/features/kunye/standing";
import {useMe} from "../../auth/useMe";
import {PHOENIX_AUTHORSHIP_LOOP} from "../../flags/keys";
import {useFlag} from "../../flags/useFlag";
import {Karma} from "../karma/Karma";
import "./CaylakStatusBlock.css";

/**
 * The block's gating decision, factored DOM-free so the contract — show iff the
 * authorship flag is on AND the viewer is a çaylak AND they are looking at their
 * OWN profile — is unit-testable without a DOM (the pure-extraction idiom of
 * `flagGateChild` / `shouldShowOnramp`). Reused to gate the per-item "incelemede"
 * badge in the contributions feed, so the badge and the block share one gate.
 */
export function shouldShowCaylakStatus(
	flagOn: boolean,
	tier: Tier | undefined,
	isOwnProfile: boolean,
): boolean {
	return flagOn && tier === "çaylak" && isOwnProfile;
}

/** The vouch-exists readout — a bare yes/no, NEVER who vouched (one-way glass). */
export function vouchExistsLabel(vouchExists: boolean): string {
	return vouchExists ? "var" : "yok";
}

/**
 * The unvouched çaylak's path-to-yazar copy. Karma is necessary-but-not-sufficient:
 * `resolveTandem` short-circuits on the vouch half (`if (!hasActiveFor) return …`),
 * so an unvouched çaylak's karma is never even read and NO amount of karma promotes
 * them — the only routes are a yazar's vouch (then the reduced 15-bar) or a mod
 * action. Surfacing the unassisted 100-bar here would depict a goal that maps to no
 * live promotion trigger (#1323), so the unvouched state shows this framing instead.
 * Lowercase Turkish; karma is a brand noun.
 */
export const VOUCH_NEEDED_COPY = {
	message: "bir yazar sana kefil olmalı",
	hint: "ya da bir moderatör seni doğrudan yükseltebilir",
} as const;

/**
 * The çaylak status block's promotion-path rendering split, factored DOM-free so the
 * unvouched-vs-vouched contract is unit-testable without a DOM (the pure-extraction
 * idiom of {@link shouldShowCaylakStatus}). The shape makes the invalid state
 * unrepresentable: the karma bar carries no copy, and the vouch-needed framing only
 * exists where there is no honest bar to draw.
 *
 * - **Unvouched** (`vouchExists === false`): no karma bar — the unassisted 100-bar
 *   would imply karma alone promotes, which it does not (#1323). Show the
 *   vouch-needed framing.
 * - **Vouched** (`vouchExists === true`): the real reduced bar (`standing.bar` is
 *   `VOUCH_PROMOTION_KARMA_BAR` = 15), the already-honest path — unchanged.
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
 * The aggregate-only wire selection: the client normalization key `id` plus the
 * four aggregate scalars. There is deliberately NO reviewer / voter / voucher
 * identity key — the one-way-glass invariant is structural on the backend type
 * (#1316) and mirrored here, so a leak can't be reintroduced by widening the
 * selection.
 */
export const STANDING_FIELDS = {
	id: true,
	karma: true,
	bar: true,
	vouchExists: true,
	inReviewCount: true,
} as const;

const StandingView = view<AuthorshipStanding>()(STANDING_FIELDS);

interface Standing {
	readonly karma: number;
	readonly bar: number;
	readonly vouchExists: boolean;
	readonly inReviewCount: number;
}

/**
 * Fetches `myAuthorshipStanding` imperatively, but only when `enabled` (the three
 * gates passed). Disabled ⇒ never touches the wire and reports `null`. Any failure
 * resolves to `null` — the safe/off path, exactly like `useFlag`'s default — so a
 * read error degrades to "no block", never a thrown header.
 */
function useAuthorshipStanding(enabled: boolean): Standing | null {
	const fate = useFateClient();
	const [standing, setStanding] = useState<Standing | null>(null);

	const refetch = useCallback(async () => {
		if (!enabled) {
			setStanding(null);
			return;
		}
		try {
			const {myAuthorshipStanding: ref} = await fate.request({
				myAuthorshipStanding: {view: StandingView},
			});
			const snapshot = ref ? await fate.readView(StandingView, ref) : null;
			// `readView` only statically narrows `id`; the selected scalars are present
			// at runtime, so we read through the known aggregate shape.
			const data = (snapshot?.data ?? null) as Standing | null;
			setStanding(
				data
					? {
							karma: data.karma,
							bar: data.bar,
							vouchExists: data.vouchExists,
							inReviewCount: data.inReviewCount,
						}
					: null,
			);
		} catch (err) {
			console.error("[useAuthorshipStanding]", err);
			setStanding(null);
		}
	}, [enabled, fate]);

	useEffect(() => {
		void refetch();
	}, [refetch]);

	return standing;
}

export interface CaylakStatusBlockProps {
	/** The profile being viewed — own-profile is `me.id === profileUserId`. */
	readonly profileUserId: string;
}

export function CaylakStatusBlock({profileUserId}: CaylakStatusBlockProps) {
	// Fail-closed default `false`: every flag failure mode (loading/error/undeclared)
	// degrades to today's behavior.
	const {value: flagOn} = useFlag(PHOENIX_AUTHORSHIP_LOOP, false);
	const {me} = useMe();
	const headingId = useId();
	const show = shouldShowCaylakStatus(flagOn, me?.tier, me?.id === profileUserId);
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
					<dt className="kp-caylak-status__term">destek</dt>
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
