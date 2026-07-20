import {useView, type ViewRef, view} from "react-fate";
import type {Profile} from "../../../worker/features/fate/views";
import {actorLabel} from "../moderation/actor-identity";
import {CaylakStatusBlock} from "./CaylakStatusBlock";
import {ProfileHeader} from "./ProfileHeader";

export const UserProfileHeaderView = view<Profile>()({
	userId: true,
	username: true,
	displayName: true,
	image: true,
	totalKarma: true,
	definitionCount: true,
	postCount: true,
	commentCount: true,
});

export interface UserProfileHeaderProps {
	profile: ViewRef<"Profile">;
	fallbackHandle: string;
}

export function UserProfileHeader(props: UserProfileHeaderProps) {
	const profile = useView(UserProfileHeaderView, props.profile);
	const displayName = actorLabel(profile.displayName, profile.username, "kullanıcı");
	const handle = profile.username ?? props.fallbackHandle;

	return (
		<>
			<ProfileHeader
				displayName={displayName}
				handle={handle}
				image={profile.image}
				stats={{
					definitionCount: profile.definitionCount,
					postCount: profile.postCount,
					commentCount: profile.commentCount,
					totalKarma: profile.totalKarma,
				}}
				showKarma
			/>
			{/* The çaylak's own "yazarlığa giden yol" status block (#1291); renders only
			    for a çaylak on their own profile, off an aggregate-only read (one-way
			    glass). */}
			<CaylakStatusBlock profileUserId={profile.userId} />
		</>
	);
}
