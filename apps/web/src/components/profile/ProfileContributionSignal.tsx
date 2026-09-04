/**
 * The thin contribution signal on the owner's own profile — a capped, recent-first
 * readout, deliberately not a feed (no in-place pagination, no analytics/streaks).
 *
 * The `Profile.contributions` resolver keys on `authorId` with no sandbox filter, so
 * the owner sees their OWN still-sandboxed rows here while the public cannot.
 *
 * It mounts its own `<Screen>` because the owner `ProfilePage` drives fate
 * imperatively above any Suspense boundary; the boundary is what lets this child
 * suspend on its own batched `useRequest`.
 */

import {Alert, EmptyState} from "@kampus/design";
import type {ReactNode} from "react";
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {Profile} from "../../../worker/features/fate/views";
import {Screen} from "../../fate/Screen";
import {useT} from "../../i18n";
import {ContributionRow, ContributionView} from "./ContributionRow";
import {CONTRIBUTIONS_EMPTY_KEYS, CONTRIBUTIONS_HEADING_KEYS} from "./profileContributions";
import "./ProfileContributionSignal.css";

const SIGNAL_SIZE = 5;

const ContributionsConnectionView = {items: {node: ContributionView}} as const;

// The count scalars are not rendered here: they make this a SUPERSET of
// `useProfileStats`'s counts-only `profile` read, which shares the `profile` root
// queryKey, so that sibling read dedupes onto this one instead of a second wire
// round-trip (#2209). Dropping them costs an extra request.
const SignalView = view<Profile>()({
	userId: true,
	postCount: true,
	commentCount: true,
	definitionCount: true,
	totalKarma: true,
	contributions: ContributionsConnectionView,
});

function SignalShell({children}: {children: ReactNode}) {
	const t = useT();
	return (
		<section
			className="kp-profile__section kp-signal"
			aria-labelledby="kp-signal-heading"
			data-testid="contribution-signal"
		>
			<h3 id="kp-signal-heading">{t(CONTRIBUTIONS_HEADING_KEYS.self)}</h3>
			{children}
		</section>
	);
}

// Shared by the `<Screen>` fallback below and the eager pre-session paint above the
// gate so the two are byte-identical and the handoff shows no visual jump. See ADR 0167.
export function ProfileContributionSkeleton() {
	return (
		<SignalShell>
			<ContributionLoading />
		</SignalShell>
	);
}

function ContributionLoading() {
	const t = useT();
	return (
		<p className="kp-signal__status" data-testid="signal-loading">
			{t("profile.contributions.loading")}
		</p>
	);
}

/**
 * Painted above the session gate, and unlike `/pano`'s eager tier it mounts NO fate
 * client on purpose: these contributions are identity-scoped, so the real read must
 * stay on the authed client below the gate, and with no client above there is nothing
 * to re-key anon→id (#438). See ADR 0167.
 */
export function EagerProfileContributionSkeleton() {
	return <ProfileContributionSkeleton />;
}

export function ProfileContributionSignal({username}: {username: string}) {
	const t = useT();
	return (
		<Screen
			fallback={<ProfileContributionSkeleton />}
			error={({code}) => (
				<SignalShell>
					<Alert
						variant="danger"
						className="kp-alert--inline kp-signal__status kp-signal__status--error"
					>
						{t("profile.contributions.error", {code: code.toLowerCase()})}
					</Alert>
				</SignalShell>
			)}
		>
			<SignalContent username={username} />
		</Screen>
	);
}

function SignalContent({username}: {username: string}) {
	const {profile} = useRequest({
		profile: {view: SignalView, args: {username, contributions: {first: SIGNAL_SIZE}}},
	});

	if (!profile) {
		return (
			<SignalShell>
				<EmptySignal />
			</SignalShell>
		);
	}

	return (
		<SignalShell>
			<SignalList profile={profile} username={username} />
		</SignalShell>
	);
}

function EmptySignal() {
	const t = useT();
	return (
		<EmptyState
			title={t(CONTRIBUTIONS_EMPTY_KEYS.title)}
			description={t(CONTRIBUTIONS_EMPTY_KEYS.description)}
		/>
	);
}

function SignalList({profile, username}: {profile: ViewRef<"Profile">; username: string}) {
	const t = useT();
	const data = useView(SignalView, profile);
	const [items, loadNext] = useListView(ContributionsConnectionView, data.contributions);

	if (items.length === 0) return <EmptySignal />;

	return (
		<>
			<ul className="kp-user-profile__list kp-signal__list">
				{items.map(({cursor, node}) => (
					<ContributionRow key={cursor} node={node} isOwn />
				))}
			</ul>
			{loadNext ? (
				<Link to={`/u/${username}`} className="kp-signal__more" data-testid="signal-see-all">
					{t("profile.contributions.seeAll")}
				</Link>
			) : null}
		</>
	);
}
