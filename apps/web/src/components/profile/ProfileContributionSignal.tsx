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

// Selects the count scalars alongside `contributions` so this read is a SUPERSET
// of `useProfileStats`'s counts-only `profile` read (#2209): the two share a
// `profile` root queryKey (root-path args `{username}`), so once this superset
// populates the record, the sibling counts-only read on `/profile` resolves those
// scalars from the normalized store instead of a second wire round-trip — the
// counts read deduped onto this fuller one. The scalars aren't rendered here.
const SignalView = view<Profile>()({
	userId: true,
	postCount: true,
	commentCount: true,
	definitionCount: true,
	totalKarma: true,
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

/**
 * The Katkıların loading skeleton — shared by the `<Screen>` fallback below and the
 * eager pre-session paint above the gate (ADR 0167 / #2188), so the skeleton the
 * always-anonymous first paint shows is byte-identical to the one the settled authed
 * read shows: no visual jump as the eager tier hands off to the below-gate read.
 */
export function ProfileContributionSkeleton() {
	return (
		<SignalShell>
			<p className="kp-signal__status" data-testid="signal-loading">
				yükleniyor…
			</p>
		</SignalShell>
	);
}

/**
 * The eager Katkıların skeleton the `/profile` route paints ABOVE the session gate
 * (mounted by `Layout` while `get-session` is still pending), the two-tier decoupling
 * of ADR 0167 extended to `/profile` (#2188). Unlike `/pano`'s eager tier it carries
 * NO fate client: the owner's own contributions are identity-scoped (the resolver
 * shows the owner their still-sandboxed rows), so the real read must stay on the authed
 * client below the gate — pre-session there is only a skeleton to paint, no anon data.
 * Mounting no `FateClient` is also what makes it #438-safe by construction: with no
 * client above the gate there is nothing to re-key anon→id.
 */
export function EagerProfileContributionSkeleton() {
	return <ProfileContributionSkeleton />;
}

export function ProfileContributionSignal({username}: {username: string}) {
	return (
		<Screen
			fallback={<ProfileContributionSkeleton />}
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
