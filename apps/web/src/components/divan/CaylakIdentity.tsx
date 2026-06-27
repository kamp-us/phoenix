/**
 * `CaylakIdentity` — a çaylak's handle + their **karma-on-others** in the divan
 * (#1290 AC). It reads the çaylak's `Profile` by id (the roster surfaces an
 * `authorId`, not a username) through fate's by-id source (`profileSource.byId`),
 * and renders the SAME reusable `<Karma>` atom (#1208) the topbar and own-profile
 * use — proving the atom is not profile-only-coupled: here it surfaces someone
 * else's karma on a non-profile surface.
 *
 * The by-id read can suspend (and, for a since-deleted çaylak, fail), so every
 * call site wraps this in its own {@link Screen} with {@link IdentityFallback} —
 * one missing profile degrades to a bare "çaylak" label instead of nuking the
 * roster or detail.
 */
import {useFateClient, useView, view} from "react-fate";
import type {Profile} from "../../../worker/features/fate/views";
import {Karma} from "../karma/Karma";
import {caylakLabel} from "./divanGating";

const CaylakProfileView = view<Profile>()({
	id: true,
	userId: true,
	username: true,
	displayName: true,
	totalKarma: true,
});

export function CaylakIdentity({
	authorId,
	showKarma = true,
}: {
	readonly authorId: string;
	readonly showKarma?: boolean;
}) {
	const fate = useFateClient();
	const ref = fate.ref("Profile", authorId, CaylakProfileView);
	const profile = useView(CaylakProfileView, ref);
	const label = caylakLabel(profile.displayName ?? null, profile.username ?? null);

	return (
		<span className="kp-divan__identity">
			<span className="kp-divan__handle">{label}</span>
			{showKarma ? (
				<Karma
					value={profile.totalKarma}
					variant="inline"
					label="karma"
					testId={`divan-karma-${authorId}`}
					className="kp-divan__karma"
				/>
			) : null}
		</span>
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
