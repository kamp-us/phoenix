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
 * badge in the contributions feed, so the badge and the block share one gate. A
 * gate that dropped any of the three halves (showed for a yazar, ignored the flag,
 * or rendered on another user's profile) would fail exactly this function.
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
 * The aggregate-only wire selection: the client normalization key `id` plus the
 * four aggregate scalars. There is deliberately NO reviewer / voter / voucher
 * identity key — the one-way-glass invariant is structural on the backend type
 * (#1316) and mirrored here, so a leak can't be reintroduced by widening the
 * selection. The unit test pins this key set.
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
	// Default `false`: the block stays dark until the server evaluates the flag on
	// AND the viewer is a çaylak on their own profile — every flag failure mode
	// (loading/error/undeclared) resolves to `false`, so the gate degrades to
	// today's behavior.
	const {value: flagOn} = useFlag(PHOENIX_AUTHORSHIP_LOOP, false);
	const {me} = useMe();
	const headingId = useId();
	const show = shouldShowCaylakStatus(flagOn, me?.tier, me?.id === profileUserId);
	const standing = useAuthorshipStanding(show);

	if (!show || !standing) return null;

	return (
		<section
			className="kp-caylak-status"
			aria-labelledby={headingId}
			data-testid="caylak-status-block"
		>
			<h2 id={headingId} className="kp-caylak-status__heading">
				yazarlığa giden yol
			</h2>
			<div className="kp-caylak-status__karma">
				<Karma
					value={standing.karma}
					target={standing.bar}
					label="karma"
					testId="caylak-status-karma"
				/>
			</div>
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
