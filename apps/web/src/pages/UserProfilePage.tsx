/**
 * Public user profile page. The nested `contributions` connection switches on a `kind`
 * discriminant (ADR 0018); see `.patterns/fate-connections.md` for the masking rules.
 */

import {EmptyState} from "@kampus/design";
import {useCallback} from "react";
import {useFateClient, useListView, useRequest, useView, type ViewRef} from "react-fate";
import {useParams} from "react-router";
import {useMe} from "../auth/useMe";
import {shouldShowCaylakStatus} from "../components/profile/CaylakStatusBlock";
import {ContributionRow} from "../components/profile/ContributionRow";
import {PromotionActions, shouldShowPromotionActions} from "../components/profile/PromotionActions";
import {
	CONTRIBUTIONS_EMPTY_KEYS,
	CONTRIBUTIONS_HEADING_KEYS,
} from "../components/profile/profileContributions";
import {
	ContributionsConnectionView,
	profileRequest,
	UserProfileView,
} from "../components/profile/profileReads";
import {UserProfileHeader, UserProfileHeaderView} from "../components/profile/UserProfileHeader";
import {Screen} from "../fate/Screen";
import {LoadMoreButton} from "../fate/wire";
import {useT} from "../i18n";
import {NotFoundPage} from "./NotFoundPage";
import "./UserProfilePage.css";

export function UserProfilePage() {
	const {username} = useParams<{username: string}>();
	const safeUsername = username ?? "";
	const t = useT();

	return (
		<Screen
			fallback={
				<div className="kp-user-profile" data-testid="user-profile-loading">
					<div className="kp-user-profile__inner">{t("profile.page.loading")}</div>
				</div>
			}
			error={({code}) => (
				<div className="kp-user-profile">
					<div className="kp-user-profile__inner">
						<p style={{color: "var(--danger)"}}>
							{t("profile.page.error", {code: code.toLowerCase()})}
						</p>
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
	const t = useT();
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
				title={t("profile.user.notFound.title")}
				message={t("profile.user.notFound.message", {username})}
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
	const t = useT();
	const data = useView(UserProfileView, profile);
	const {userId} = useView(UserProfileHeaderView, profile);
	const {me} = useMe();
	const isOwn = me?.id === userId;
	const sandboxBadge = shouldShowCaylakStatus(me?.tier, isOwn);
	const [items, loadNext] = useListView(ContributionsConnectionView, data.contributions);

	return (
		<section className="kp-user-profile__feed" data-testid="user-profile-feed">
			<h3>{t(CONTRIBUTIONS_HEADING_KEYS.public)}</h3>
			{items.length === 0 ? (
				<EmptyState
					title={t(CONTRIBUTIONS_EMPTY_KEYS.title)}
					description={t(CONTRIBUTIONS_EMPTY_KEYS.description)}
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
