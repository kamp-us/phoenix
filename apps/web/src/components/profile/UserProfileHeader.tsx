import {useView, type ViewRef, view} from "react-fate";
import type {Profile} from "../../../worker/features/fate/views";
import {CaylakStatusBlock} from "./CaylakStatusBlock";

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

function initialsOf(name: string) {
	return name
		.split(/\s+|_|-/)
		.filter(Boolean)
		.slice(0, 2)
		.map((p) => p[0]?.toUpperCase() ?? "")
		.join("");
}

export interface UserProfileHeaderProps {
	profile: ViewRef<"Profile">;
	fallbackHandle: string;
}

export function UserProfileHeader(props: UserProfileHeaderProps) {
	const profile = useView(UserProfileHeaderView, props.profile);
	const displayName = profile.displayName ?? profile.username ?? "kullanıcı";
	const handle = profile.username ?? props.fallbackHandle;

	return (
		<>
			<header className="kp-user-profile__head">
				<div className="kp-user-profile__avatar" aria-hidden>
					{profile.image ? (
						<img src={profile.image} alt="" />
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
			{/* The çaylak's own "yazarlığa giden yol" status block (#1291), dark behind
			    the #1204 authorship-loop flag; renders only for a çaylak on their own
			    profile, off an aggregate-only read (one-way glass). */}
			<CaylakStatusBlock profileUserId={profile.userId} />
		</>
	);
}
