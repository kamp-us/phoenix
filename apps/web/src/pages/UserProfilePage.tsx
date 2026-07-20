/**
 * Public user profile page — fate. One batched `useRequest` resolves header +
 * first page of contributions; the screen view **spreads** `UserProfileHeaderView`
 * and adds the nested `contributions` connection (node: `ContributionView`), which
 * switches on the `kind` discriminant (ADR 0018). See `.patterns/fate-connections.md`.
 */
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import {useParams} from "react-router";
import type {Profile} from "../../worker/features/fate/views";
import {useMe} from "../auth/useMe";
import {shouldShowCaylakStatus} from "../components/profile/CaylakStatusBlock";
import {ContributionRow, ContributionView} from "../components/profile/ContributionRow";
import {PromotionActions, shouldShowPromotionActions} from "../components/profile/PromotionActions";
import {
	CONTRIBUTIONS_EMPTY,
	CONTRIBUTIONS_HEADING,
} from "../components/profile/profileContributions";
import {UserProfileHeader, UserProfileHeaderView} from "../components/profile/UserProfileHeader";
import {EmptyState} from "../components/ui/EmptyState";
import {Screen} from "../fate/Screen";
import {LoadMoreButton} from "../fate/wire";
import {NotFoundPage} from "./NotFoundPage";
import "./UserProfilePage.css";

const PAGE_SIZE = 20;

const ContributionsConnectionView = {items: {node: ContributionView}} as const;

const UserProfileView = view<Profile>()({
	...UserProfileHeaderView,
	contributions: ContributionsConnectionView,
});

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
	const {profile} = useRequest({
		profile: {view: UserProfileView, args: {username, contributions: {first: PAGE_SIZE}}},
	});

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
				{/* The çaylak→yazar promotion surface (#1206); the server is the sole authority. */}
				<ProfilePromotion profile={profile} />
				<ContributionsList profile={profile} />
			</div>
		</div>
	);
}

function ProfilePromotion({profile}: {profile: ViewRef<"Profile">}) {
	const {userId} = useView(UserProfileHeaderView, profile);
	const {me} = useMe();
	// Mirror the divan's promote gate: mod-only + never own-profile (#1841). Absent
	// me (loading / signed-out) reads as non-moderator ⇒ hidden.
	if (!shouldShowPromotionActions(me?.isModerator ?? false, me?.id === userId)) return null;
	return <PromotionActions userId={userId} />;
}

function ContributionsList({profile}: {profile: ViewRef<"Profile">}) {
	const data = useView(UserProfileView, profile);
	const {userId} = useView(UserProfileHeaderView, profile);
	const {me} = useMe();
	// Same gate as the status block: the "incelemede" badge shows only for a çaylak
	// viewing their own profile. A non-owner never receives a sandboxed row from the
	// server, so this also keeps the badge off others' feeds.
	const sandboxBadge = shouldShowCaylakStatus(me?.tier, me?.id === userId);
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
						<ContributionRow key={cursor} node={node} sandboxBadge={sandboxBadge} />
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
