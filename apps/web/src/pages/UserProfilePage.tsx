/**
 * Public user profile page.
 *
 * Idiomatic Relay shape: `useLazyLoadQuery` at the top spreads
 * `UserProfileHeaderFragment` + `UserProfileContributionsFragment` into the
 * `Profile` selection; `usePaginationFragment` reads the contributions
 * connection. Each row is a fragment ref handed to `ContributionRow` (which
 * does an inline `__typename` switch over `ProfileContribution`).
 *
 * The connection key is `UserProfile_contributions` (no filters today; if
 * `kind` filtering lands later the connection shape can grow `filters: ["kind"]`
 * without renaming the key — the connection-key naming convention only
 * requires `<SomeName>__<fieldName>`).
 */
import {graphql, useLazyLoadQuery, usePaginationFragment} from "react-relay";
import {useParams} from "react-router";
import type {UserProfilePageContributionsFragment$key} from "../__generated__/UserProfilePageContributionsFragment.graphql";
import type {UserProfilePageQuery} from "../__generated__/UserProfilePageQuery.graphql";
import {ContributionRow} from "../components/profile/ContributionRow";
import {UserProfileHeader} from "../components/profile/UserProfileHeader";
import {Button} from "../components/ui/Button";
import {QueryBoundary} from "../relay/QueryBoundary";
import {NotFoundPage} from "./NotFoundPage";
import "./UserProfilePage.css";

const PAGE_SIZE = 20;

const ProfileQuery = graphql`
	query UserProfilePageQuery($username: String!, $first: Int) {
		profile(username: $username) {
			id
			...UserProfileHeaderFragment
			...UserProfilePageContributionsFragment @arguments(first: $first)
		}
	}
`;

/**
 * Contributions connection on `Profile`. `@refetchable` lets
 * `usePaginationFragment` load subsequent pages; `@connection` lets future
 * mutation updaters address the connection by stable key + the parent's
 * DataID. `__id` is auto-emitted by relay-compiler when this fragment is
 * spread, so the parent `Profile` carries the connection-id template
 * `client:${profile.__id}:__UserProfile_contributions_connection`.
 *
 * No `filters` arg today (no per-kind filter UI); when filtering lands the
 * connection shape can grow `filters: ["kind"]` without renaming the key.
 */
const UserProfilePageContributionsFragmentDef = graphql`
	fragment UserProfilePageContributionsFragment on Profile
	@argumentDefinitions(
		first: {type: "Int", defaultValue: 20}
		after: {type: "String"}
	)
	@refetchable(queryName: "UserProfileContributionsPaginationQuery") {
		contributions(first: $first, after: $after)
			@connection(key: "UserProfile__contributions") {
			edges {
				cursor
				node {
					...ContributionRow_node
				}
			}
			pageInfo {
				hasNextPage
				endCursor
			}
			totalCount
		}
	}
`;

export function UserProfilePage() {
	const {username} = useParams<{username: string}>();
	const safeUsername = username ?? "";

	return (
		<QueryBoundary
			loading={
				<div className="kp-user-profile" data-testid="user-profile-loading">
					<div className="kp-user-profile__inner">yükleniyor…</div>
				</div>
			}
			error={(err) => (
				<div className="kp-user-profile">
					<div className="kp-user-profile__inner">
						<p style={{color: "var(--danger)"}}>profil yüklenemedi: {err.message}</p>
					</div>
				</div>
			)}
		>
			<UserProfileContent username={safeUsername} />
		</QueryBoundary>
	);
}

function UserProfileContent({username}: {username: string}) {
	const data = useLazyLoadQuery<UserProfilePageQuery>(ProfileQuery, {
		username,
		first: PAGE_SIZE,
	});

	if (!data.profile) {
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
				<UserProfileHeader profile={data.profile} fallbackHandle={username} />
				<ContributionsList profile={data.profile} />
			</div>
		</div>
	);
}

function ContributionsList({
	profile,
}: {
	profile: UserProfilePageContributionsFragment$key;
}) {
	const {data, loadNext, hasNext, isLoadingNext} = usePaginationFragment(
		UserProfilePageContributionsFragmentDef,
		profile,
	);
	const edges = data.contributions.edges;

	return (
		<section className="kp-user-profile__feed" data-testid="user-profile-feed">
			<h3>
				katkılar{" "}
				<span
					className="kp-user-profile__total"
					data-testid="user-profile-contributions-total"
				>
					({data.contributions.totalCount})
				</span>
			</h3>
			{edges.length === 0 ? (
				<p className="kp-user-profile__empty">henüz katkı yok.</p>
			) : (
				<ul className="kp-user-profile__list">
					{edges.map((edge) => (
						<ContributionRow key={edge.cursor} node={edge.node} />
					))}
				</ul>
			)}
			{hasNext ? (
				<div
					style={{
						marginTop: "var(--s-3)",
						display: "flex",
						justifyContent: "center",
					}}
					data-testid="user-profile-load-more-row"
				>
					<Button
						variant="tertiary"
						size="sm"
						type="button"
						disabled={isLoadingNext}
						onClick={() => loadNext(PAGE_SIZE)}
						data-testid="user-profile-load-more"
					>
						{isLoadingNext ? "yükleniyor…" : "daha fazla"}
					</Button>
				</div>
			) : null}
		</section>
	);
}
