/**
 * Public user profile page — fate. One batched `useRequest` resolves header +
 * first page of contributions; the screen view **spreads** `UserProfileHeaderView`
 * and adds the nested `contributions` connection (node: `ContributionView`), which
 * switches on the `kind` discriminant (ADR 0018). See `.patterns/fate-connections.md`.
 */
import {Suspense} from "react";
import {
	type Deferred,
	defer,
	useListView,
	useRequest,
	useView,
	type ViewRef,
	view,
} from "react-fate";
import {useParams} from "react-router";
import type {Profile} from "../../worker/features/fate/views";
import {useMe} from "../auth/useMe";
import {shouldShowCaylakStatus} from "../components/profile/CaylakStatusBlock";
import {ContributionRow, ContributionView} from "../components/profile/ContributionRow";
import {PromotionActions, shouldShowPromotionActions} from "../components/profile/PromotionActions";
import {UserProfileHeader, UserProfileHeaderView} from "../components/profile/UserProfileHeader";
import {Skeleton} from "../components/ui/atoms";
import {Screen} from "../fate/Screen";
import {LoadMoreButton} from "../fate/wire";
import {FlagGate} from "../flags/FlagGate";
import {PHOENIX_AUTHORSHIP_LOOP} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {NotFoundPage} from "./NotFoundPage";
import "./UserProfilePage.css";

const PAGE_SIZE = 20;

/** Rows the deferred-list skeleton reserves below the fold while contributions load. */
const CONTRIBUTION_SKELETON_ROWS = 5;

const ContributionsConnectionView = {items: {node: ContributionView}} as const;

/**
 * Strip the `| undefined` a nullable server relation leaves in a `defer`'d handle's
 * branded payload, so `useListView`'s deferred arm (which wants `Deferred<ConnectionValue>`)
 * accepts it — see the narrowing note in `ContributionsList`.
 */
type NonNullableDeferred<D> = D extends Deferred<infer V> ? Deferred<NonNullable<V>> : D;

/**
 * `contributions` is `defer`'d: the header (name/tier/karma — above the fold, from
 * eager aggregate counts) resolves on the eager request and paints immediately, while
 * the below-the-fold contributions connection loads under its OWN `<Suspense>`
 * boundary (`ContributionsList`), so the screen isn't gated on the slowest loader
 * (#2161). fate omits the deferred selection from the eager request and fetches it when
 * the handle is read, suspending only that component — see `.patterns/fate-async-react.md`.
 */
const UserProfileView = view<Profile>()({
	...UserProfileHeaderView,
	contributions: defer(ContributionsConnectionView),
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
				<Suspense fallback={<ContributionsSkeleton />}>
					<ContributionsList profile={profile} />
				</Suspense>
			</div>
		</div>
	);
}

/**
 * Height-matched fallback for the deferred contributions list: the `katkılar`
 * heading over a few row-shaped placeholders that mirror `.kp-user-profile__row`, so
 * the section reserves its space and the arriving list swaps in without a jump (#2161).
 */
function ContributionsSkeleton() {
	return (
		<section
			className="kp-user-profile__feed"
			data-testid="user-profile-feed-loading"
			role="status"
			aria-busy="true"
			aria-label="katkılar yükleniyor…"
		>
			<h3>katkılar</h3>
			<ul className="kp-user-profile__list">
				{Array.from({length: CONTRIBUTION_SKELETON_ROWS}, (_, i) => (
					<li key={i} className="kp-user-profile__row" aria-hidden="true">
						<div className="kp-user-profile__row-head">
							<Skeleton width={64} height={16} />
							<Skeleton width={90} height={12} />
						</div>
						<Skeleton width="70%" height={14} />
					</li>
				))}
			</ul>
		</section>
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
	const {value: flagOn} = useFlag(PHOENIX_AUTHORSHIP_LOOP, false);
	const {me} = useMe();
	// Same three-gate as the status block: the "incelemede" badge shows only for a
	// çaylak viewing their own profile behind the flag. A non-owner never receives a
	// sandboxed row from the server, so this also keeps the badge off others' feeds.
	const sandboxBadge = shouldShowCaylakStatus(flagOn, me?.tier, me?.id === userId);
	// `Profile.contributions` is a nullable server relation (`{contributions?: …}`), so
	// `defer` brands the handle with the `| undefined` payload; `useListView`'s deferred
	// arm requires a non-nullable `Deferred<ConnectionValue>` inner. The handle is never
	// actually undefined at read time — fate fetches the deferred selection before this
	// component resolves — so narrow the branded payload here. `useListView` still yields
	// `[]` for a genuinely empty connection, keeping the `items.length === 0` branch intact.
	const contributions = data.contributions as NonNullableDeferred<typeof data.contributions>;
	const [items, loadNext] = useListView(ContributionsConnectionView, contributions);

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
