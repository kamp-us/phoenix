/**
 * Public user profile page. The nested `contributions` connection switches on a `kind`
 * discriminant (ADR 0018); see `.patterns/fate-connections.md` for the masking rules.
 */
import {useCallback} from "react";
import {useFateClient, useListView, useRequest, useView, type ViewRef} from "react-fate";
import {useParams} from "react-router";
import {useMe} from "../auth/useMe";
import {shouldShowCaylakStatus} from "../components/profile/CaylakStatusBlock";
import {ContributionRow} from "../components/profile/ContributionRow";
import {PromotionActions, shouldShowPromotionActions} from "../components/profile/PromotionActions";
import {
	CONTRIBUTIONS_EMPTY,
	CONTRIBUTIONS_HEADING,
} from "../components/profile/profileContributions";
import {
	ContributionsConnectionView,
	profileRequest,
	UserProfileView,
} from "../components/profile/profileReads";
import {UserProfileHeader, UserProfileHeaderView} from "../components/profile/UserProfileHeader";
import {EmptyState} from "../components/ui/EmptyState";
import {Screen} from "../fate/Screen";
import {LoadMoreButton} from "../fate/wire";
import {NotFoundPage} from "./NotFoundPage";
import "./UserProfilePage.css";

export function UserProfilePage() {
	const {username} = useParams<{username: string}>();
	const safeUsername = username ?? "";

	return (
		<Screen
			fallback={
				<div className="kp-user-profile" data-testid="user-profile-loading">
					<div className="kp-user-profile__inner">yükleniyor…</div>
				</div>
			}
			error={({code}) => (
				<div className="kp-user-profile">
					<div className="kp-user-profile__inner">
						<p style={{color: "var(--danger)"}}>profil yüklenemedi: {code.toLowerCase()}</p>
					</div>
				</div>
			)}
		>
			<UserProfileContent username={safeUsername} />
		</Screen>
	);
}

function UserProfileContent({username}: {username: string}) {
	const fate = useFateClient();
	const {profile} = useRequest(profileRequest(username));
	// The same network-only re-pull the divan promote handler drives (#7036): a settled
	// tier answer re-pulls this page's read so the rendered status can't stay stale.
	const refetchProfile = useCallback(
		() => fate.request(profileRequest(username), {mode: "network-only"}),
		[fate, username],
	);

	if (!profile) {
		return (
			<NotFoundPage
				title="kullanıcı bulunamadı"
				message={`@${username} burada yok. başka bir şeye bakmak ister misin?`}
			/>
		);
	}

	return (
		<div className="kp-user-profile" data-testid="user-profile-page">
			<div className="kp-user-profile__inner">
				<UserProfileHeader profile={profile} fallbackHandle={username} />
				<ProfilePromotion
					profile={profile}
					onSuccessRefresh={() => void refetchProfile().catch(() => undefined)}
				/>
				<ContributionsList profile={profile} />
			</div>
		</div>
	);
}

function ProfilePromotion({
	profile,
	onSuccessRefresh,
}: {
	profile: ViewRef<"Profile">;
	onSuccessRefresh?: () => void;
}) {
	const {userId} = useView(UserProfileHeaderView, profile);
	const {me} = useMe();
	// Mirror the divan's promote gate: mod-only + never own-profile (#1841). Absent
	// me (loading / signed-out) reads as non-moderator ⇒ hidden.
	if (!shouldShowPromotionActions(me?.isModerator ?? false, me?.id === userId)) return null;
	return <PromotionActions userId={userId} onSuccessRefresh={onSuccessRefresh} />;
}

function ContributionsList({profile}: {profile: ViewRef<"Profile">}) {
	const data = useView(UserProfileView, profile);
	const {userId} = useView(UserProfileHeaderView, profile);
	const {me} = useMe();
	const isOwn = me?.id === userId;
	const sandboxBadge = shouldShowCaylakStatus(me?.tier, isOwn);
	const [items, loadNext] = useListView(ContributionsConnectionView, data.contributions);

	return (
		<section className="kp-user-profile__feed" data-testid="user-profile-feed">
			<h3>{CONTRIBUTIONS_HEADING.public}</h3>
			{items.length === 0 ? (
				<EmptyState
					title={CONTRIBUTIONS_EMPTY.title}
					description={CONTRIBUTIONS_EMPTY.description}
				/>
			) : (
				<ul className="kp-user-profile__list">
					{items.map(({cursor, node}) => (
						<ContributionRow key={cursor} node={node} isOwn={isOwn} sandboxBadge={sandboxBadge} />
					))}
				</ul>
			)}
			{loadNext ? (
				<div
					style={{
						marginTop: "var(--s-3)",
						display: "flex",
						justifyContent: "center",
					}}
					data-testid="user-profile-load-more-row"
				>
					<LoadMoreButton loadNext={loadNext} testId="user-profile-load-more" />
				</div>
			) : null}
		</section>
	);
}
