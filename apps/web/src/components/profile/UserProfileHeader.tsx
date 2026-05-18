/**
 * Fragment-shaped profile header.
 *
 * Reads its data via `useFragment(UserProfileHeaderFragment)` instead of
 * taking shaped props. The page (`UserProfilePage`) spreads this fragment
 * into the top-level `Profile` selection — the header declares what it
 * needs.
 */
import {graphql, useFragment} from "react-relay";
import type {UserProfileHeaderFragment$key} from "../../__generated__/UserProfileHeaderFragment.graphql";

const UserProfileHeaderFragmentDef = graphql`
	fragment UserProfileHeaderFragment on Profile {
		id
		user {
			id
			username
			name
			image
		}
		totalKarma
		definitionCount
		postCount
		commentCount
	}
`;

function initialsOf(name: string) {
	return name
		.split(/\s+|_|-/)
		.filter(Boolean)
		.slice(0, 2)
		.map((p) => p[0]?.toUpperCase() ?? "")
		.join("");
}

export interface UserProfileHeaderProps {
	profile: UserProfileHeaderFragment$key;
	fallbackHandle: string;
}

export function UserProfileHeader(props: UserProfileHeaderProps) {
	const profile = useFragment(UserProfileHeaderFragmentDef, props.profile);
	const displayName = profile.user.name ?? profile.user.username ?? "kullanıcı";
	const handle = profile.user.username ?? props.fallbackHandle;

	return (
		<header className="kp-user-profile__head">
			<div className="kp-user-profile__avatar" aria-hidden>
				{profile.user.image ? (
					<img src={profile.user.image} alt="" />
				) : (
					<span>{initialsOf(displayName)}</span>
				)}
			</div>
			<div className="kp-user-profile__id">
				<div className="kp-user-profile__name" data-testid="user-profile-display-name">
					{displayName}
				</div>
				<div className="kp-user-profile__handle" data-testid="user-profile-handle">
					@{handle}
				</div>
			</div>
			<div className="kp-user-profile__stats" data-testid="user-profile-stats">
				<div className="kp-user-profile__stat" data-testid="stat-definitions">
					<div className="n">{profile.definitionCount}</div>
					<div className="l">tanım</div>
				</div>
				<div className="kp-user-profile__stat" data-testid="stat-posts">
					<div className="n">{profile.postCount}</div>
					<div className="l">başlık</div>
				</div>
				<div className="kp-user-profile__stat" data-testid="stat-comments">
					<div className="n">{profile.commentCount}</div>
					<div className="l">yorum</div>
				</div>
				<div className="kp-user-profile__stat" data-testid="stat-karma">
					<div className="n">{profile.totalKarma}</div>
					<div className="l">karma</div>
				</div>
			</div>
		</header>
	);
}
