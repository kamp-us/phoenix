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
import {PromotionActions} from "../components/profile/PromotionActions";
import {UserProfileHeader, UserProfileHeaderView} from "../components/profile/UserProfileHeader";
import {Screen} from "../fate/Screen";
import {LoadMoreButton} from "../fate/wire";
import {FlagGate} from "../flags/FlagGate";
import {PHOENIX_AUTHORSHIP_LOOP} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
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
				{/* The çaylak→yazar promotion surface (#1206), dark behind the #1204
				    authorship-loop flag; the server is the sole authority. */}
				<FlagGate flag={PHOENIX_AUTHORSHIP_LOOP}>
					<ProfilePromotion profile={profile} />
				</FlagGate>
				<ContributionsList profile={profile} />
			</div>
		</div>
	);
}

function ProfilePromotion({profile}: {profile: ViewRef<"Profile">}) {
	const {userId} = useView(UserProfileHeaderView, profile);
	return <PromotionActions userId={userId} />;
}

function ContributionsList({profile}: {profile: ViewRef<"Profile">}) {
	const data = useView(UserProfileView, profile);
	const {userId} = useView(UserProfileHeaderView, profile);
	const {value: flagOn} = useFlag(PHOENIX_AUTHORSHIP_LOOP, false);
	const {me} = useMe();
	// Same three-gate as the status block: the "incelemede" badge shows only for a
	// çaylak viewing their own profile behind the flag. A non-owner never receives a
	// sandboxed row from the server, so this also keeps the badge off others' feeds.
	const sandboxBadge = shouldShowCaylakStatus(flagOn, me?.tier, me?.id === userId);
	const [items, loadNext] = useListView(ContributionsConnectionView, data.contributions);

	return (
		<section className="kp-user-profile__feed" data-testid="user-profile-feed">
			<h3>katkılar</h3>
			{items.length === 0 ? (
				<p className="kp-user-profile__empty">henüz katkı yok.</p>
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
