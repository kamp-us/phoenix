/**
 * Public user profile page — fate.
 *
 * One batched `useRequest({profile: {view: UserProfileView, args: {username,
 * contributions: {first}}}})` resolves the whole screen (header + first page of
 * contributions) with no waterfall. `profile` is the `queries.profile` client
 * root; the nested `contributions` discriminant feed rides on the `Profile`
 * view, delivered inline by the resolver (see `.patterns/fate-connections.md`).
 *
 * Masking is by view identity: the screen view **spreads**
 * `UserProfileHeaderView` (the header reads its slice off the same ref) and adds
 * the `contributions` connection whose node is `ContributionView` (the row's
 * view). The contributions feed switches on the `kind` discriminant (ADR 0018)
 * and paginates via `useListView` ("load more"). A null profile (unknown
 * username) renders the 404 page.
 */
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import {useParams} from "react-router";
import type {Profile} from "../../worker/features/fate/views";
import {ContributionRow, ContributionView} from "../components/profile/ContributionRow";
import {UserProfileHeader, UserProfileHeaderView} from "../components/profile/UserProfileHeader";
import {Screen} from "../fate/Screen";
import {LoadMoreButton} from "../fate/wire";
import {NotFoundPage} from "./NotFoundPage";
import "./UserProfilePage.css";

const PAGE_SIZE = 20;

/**
 * The connection selection for a profile's contributions — `{items: {node:
 * View}}`, the shape `useListView` reads off `profile.contributions`.
 */
const ContributionsConnectionView = {items: {node: ContributionView}} as const;

/**
 * The profile-page view: spreads `UserProfileHeaderView` (so the header masks
 * its slice off the same ref) and adds the nested `contributions` connection
 * whose node is `ContributionView`.
 */
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
				<ContributionsList profile={profile} />
			</div>
		</div>
	);
}

function ContributionsList({profile}: {profile: ViewRef<"Profile">}) {
	const data = useView(UserProfileView, profile);
	const [items, loadNext] = useListView(ContributionsConnectionView, data.contributions);

	return (
		<section className="kp-user-profile__feed" data-testid="user-profile-feed">
			<h3>katkılar</h3>
			{items.length === 0 ? (
				<p className="kp-user-profile__empty">henüz katkı yok.</p>
			) : (
				<ul className="kp-user-profile__list">
					{items.map(({cursor, node}) => (
						<ContributionRow key={cursor} node={node} />
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
