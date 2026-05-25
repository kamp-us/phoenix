/**
 * The current user, read through fate. Exercises the whole client foundation
 * end-to-end:
 *   - a `view<User>()` selection over the generated `User` entity type,
 *   - one batched `useRequest({ me: ... })` against the generated `me` root
 *     (the `viewer` pattern — backed by the server `queries.me` resolver),
 *   - a child `useView` reading the masked record from the normalized cache,
 *   - all under `<Screen>` (Suspense + error boundary). `me` is auth-gated, so
 *     an unauthenticated read throws `UNAUTHORIZED` to the boundary — which is
 *     also the boundary's smoke test.
 *
 * It renders alongside the session-derived identity on the profile page; the
 * value here comes over `/fate` (cookie-authenticated), proving the path.
 */
import {useRequest, useView, view} from "react-fate";
import type {User} from "../../worker/fate/views";
import {Screen} from "./Screen";

const MeView = view<User>()({
	id: true,
	email: true,
	name: true,
	username: true,
});

function MeContent() {
	const {me} = useRequest({me: {view: MeView}});
	const user = useView(MeView, me);

	return (
		<div className="kp-profile__row" data-testid="fate-me">
			<span className="label">fate · me</span>
			<span className="value">
				{user.username ? `@${user.username}` : (user.name ?? user.email)}
			</span>
			<span className="edit-btn" style={{color: "var(--text-faint)"}}>
				/fate
			</span>
		</div>
	);
}

export function FateMeCard() {
	return (
		<Screen
			fallback={
				<div className="kp-profile__row" data-testid="fate-me-loading">
					<span className="label">fate · me</span>
					<span className="value">…</span>
					<span />
				</div>
			}
			error={({code}) => (
				<div className="kp-profile__row" data-testid="fate-me-error">
					<span className="label">fate · me</span>
					<span className="value">— ({code.toLowerCase()})</span>
					<span />
				</div>
			)}
		>
			<MeContent />
		</Screen>
	);
}
