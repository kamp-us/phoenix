/**
 * The thin contribution signal on the owner's own profile (#1209): a lightweight
 * readout of the most recent few contributions so a çaylak sees their track record
 * accumulating toward promotion. Reuses the existing `Contribution` activity view
 * (`ContributionRow` + the `Profile.contributions` connection) — NOT a new query.
 *
 * It is intentionally thin (out of scope: a full analytics dashboard / streaks /
 * gamification): a capped, recent-first list with a "tümünü gör" link to the full
 * public feed when there's more — no in-place pagination.
 *
 * Sandbox honesty (AC #2): the `Profile.contributions` resolver keys the feed on
 * `authorId` (the profile owner) with no sandbox filter, so the owner sees their OWN
 * still-sandboxed content here — their record stays legible to them while it is hidden
 * from the public.
 *
 * Renders under its own `<Screen>` because the owner `ProfilePage` drives fate
 * imperatively above any Suspense boundary (see `useProfileStats`); the boundary lets
 * this child suspend on its own batched `useRequest` like the public `UserProfilePage`.
 */
import type {ReactNode} from "react";
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {Profile} from "../../../worker/features/fate/views";
import {Screen} from "../../fate/Screen";
import {EmptyState} from "../ui/EmptyState";
import {ContributionRow, ContributionView} from "./ContributionRow";
import {CONTRIBUTIONS_EMPTY, CONTRIBUTIONS_HEADING} from "./profileContributions";
import "./ProfileContributionSignal.css";

// Thin by design: just enough recent items to read as a track record, never a feed.
const SIGNAL_SIZE = 5;

const ContributionsConnectionView = {items: {node: ContributionView}} as const;

const SignalView = view<Profile>()({
	userId: true,
	contributions: ContributionsConnectionView,
});

function SignalShell({children}: {children: ReactNode}) {
	return (
		<section
			className="kp-profile__section kp-signal"
			aria-labelledby="kp-signal-heading"
			data-testid="contribution-signal"
		>
			<h3 id="kp-signal-heading">{CONTRIBUTIONS_HEADING.self}</h3>
			{children}
		</section>
	);
}

export function ProfileContributionSignal({username}: {username: string}) {
	return (
		<Screen
			fallback={
				<SignalShell>
					<p className="kp-signal__status" data-testid="signal-loading">
						yükleniyor…
					</p>
				</SignalShell>
			}
			error={({code}) => (
				<SignalShell>
					<p className="kp-signal__status kp-signal__status--error" role="alert">
						katkılar yüklenemedi: {code.toLowerCase()}
					</p>
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

	// A null profile (owner not yet bootstrapped) reads as an empty record, not an
	// error — the honest-empty-state stance of `useProfileStats` (#448). The list
	// hooks live in `SignalList`, mounted only with a non-null ref.
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
	return (
		<EmptyState title={CONTRIBUTIONS_EMPTY.title} description={CONTRIBUTIONS_EMPTY.description} />
	);
}

function SignalList({profile, username}: {profile: ViewRef<"Profile">; username: string}) {
	const data = useView(SignalView, profile);
	const [items, loadNext] = useListView(ContributionsConnectionView, data.contributions);

	if (items.length === 0) return <EmptySignal />;

	return (
		<>
			<ul className="kp-user-profile__list kp-signal__list">
				{items.map(({cursor, node}) => (
					<ContributionRow key={cursor} node={node} />
				))}
			</ul>
			{loadNext ? (
				<Link to={`/u/${username}`} className="kp-signal__more" data-testid="signal-see-all">
					tümünü gör
				</Link>
			) : null}
		</>
	);
}
