/**
 * `CaylakIdentity` — a çaylak's handle + their **karma-on-others** in the divan
 * (#1290 AC). It renders the SAME reusable `<Karma>` atom (#1208) the topbar and
 * own-profile use — proving the atom is not profile-only-coupled: here it surfaces
 * someone else's karma on a non-profile surface.
 *
 * Two shapes, one renderer:
 *   - {@link CaylakIdentity} (presentational) takes the identity fields directly, so
 *     a caller that already resolved them in a BATCHED read (the roster, #1423)
 *     renders with NO per-row by-id `Profile` read — the identity rides the roster's
 *     single `useRequest` (ADR 0021's no-waterfalls contract). A gone profile arrives
 *     as null handle + 0 karma, and {@link caylakLabel} degrades it to the bare
 *     "çaylak" label.
 *   - {@link CaylakIdentityById} fetches one profile by id for the single-çaylak
 *     detail surface (`CaylakDetail`), where ONE by-id read is fine (1 row, not N).
 *     The read can suspend (and, for a since-deleted çaylak, fail), so that call site
 *     wraps it in its own {@link Screen} with {@link IdentityFallback}.
 */
import {useFateClient, useView, view} from "react-fate";
import type {Profile} from "../../../worker/features/fate/views";
import {Karma} from "../karma/Karma";
import {caylakLabel} from "./divanGating";

export function CaylakIdentity({
	authorId,
	displayName,
	username,
	totalKarma,
	showKarma = true,
}: {
	readonly authorId: string;
	readonly displayName: string | null;
	readonly username: string | null;
	readonly totalKarma: number;
	readonly showKarma?: boolean;
}) {
	const label = caylakLabel(displayName, username);

	return (
		<span className="kp-divan__identity">
			<span className="kp-divan__handle">{label}</span>
			{showKarma ? (
				<Karma
					value={totalKarma}
					variant="inline"
					label="karma"
					testId={`divan-karma-${authorId}`}
					className="kp-divan__karma"
				/>
			) : null}
		</span>
	);
}

const CaylakProfileView = view<Profile>()({
	id: true,
	userId: true,
	username: true,
	displayName: true,
	totalKarma: true,
});

export function CaylakIdentityById({
	authorId,
	showKarma = true,
}: {
	readonly authorId: string;
	readonly showKarma?: boolean;
}) {
	const fate = useFateClient();
	const ref = fate.ref("Profile", authorId, CaylakProfileView);
	const profile = useView(CaylakProfileView, ref);

	return (
		<CaylakIdentity
			authorId={authorId}
			displayName={profile.displayName ?? null}
			username={profile.username ?? null}
			totalKarma={profile.totalKarma}
			showKarma={showKarma}
		/>
	);
}

/** The degraded handle shown while a çaylak's profile loads or if it is gone. */
export function IdentityFallback() {
	return (
		<span className="kp-divan__identity">
			<span className="kp-divan__handle">çaylak</span>
		</span>
	);
}
