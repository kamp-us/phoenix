/**
 * The current user read through fate, on the profile page. Doubles as the
 * end-to-end smoke test of the client foundation: `me` is auth-gated, so an
 * unauthenticated read throws `UNAUTHORIZED` to the `<Screen>` boundary.
 * See `.patterns/fate-views-and-requests.md`.
 */
import {useRequest, useView, view} from "react-fate";
import type {User} from "../../worker/features/fate/views";
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
