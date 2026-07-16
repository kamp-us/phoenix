/**
 * `MutesPage` — the `/susturduklarim` manage-my-mutes route (#3117, epic #2035): the viewer's
 * susturduklarım screen, off the `mute.listMine` read model (#3114). The reachable surface of
 * the member-mute vertical, alongside the feed "sustur" affordance (`MuteButton`).
 *
 * Ships dark behind the default-off `member-mute` flag: with the flag off the route self-404s
 * (the `BildirimlerPage` / `MecmuaIndexPage` self-gate idiom), so it is effectively absent
 * until a human flips the flag at release (ADR 0083); loading shows a neutral placeholder so
 * the 404 never flashes before the flag resolves. Signed-out redirects to auth with a
 * `returnTo` back here — managing your own mutes is a signed-in surface.
 */
import {Navigate} from "react-router";
import {useSession} from "../auth/client";
import {MutedMembersList} from "../components/mute/MutedMembersList";
import {Screen} from "../fate/Screen";
import {MEMBER_MUTE} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {authRedirectPath} from "../lib/returnTo";
import {NotFoundPage} from "./NotFoundPage";
import "./MutesPage.css";

export function MutesPage() {
	const {value: flagOn, loading: flagLoading} = useFlag(MEMBER_MUTE, false);
	const session = useSession();

	// Don't decide 404-vs-page until the flag resolves, or the 404 flashes first.
	if (flagLoading || session.isPending) {
		return (
			<div className="kp-mutes">
				<div className="kp-mutes__inner">
					<p className="kp-mutes__loading">yükleniyor…</p>
				</div>
			</div>
		);
	}

	if (!flagOn) return <NotFoundPage />;

	if (!session.data?.user) {
		return <Navigate to={authRedirectPath("/susturduklarim")} replace />;
	}

	return (
		<main className="kp-mutes" data-testid="mutes-page">
			<div className="kp-mutes__inner">
				<header className="kp-mutes__masthead">
					<h1 className="kp-mutes__title">susturduklarım</h1>
					<p className="kp-mutes__lede">
						susturduğun üyelerin içerikleri akışında görünmez. buradan sessizliği geri alabilirsin.
					</p>
				</header>
				<Screen
					fallback={<p className="kp-mutes__loading">yükleniyor…</p>}
					error={({code}) => (
						<p className="kp-mutes__error" role="alert">
							{code === "UNAUTHORIZED" || code === "FORBIDDEN"
								? "susturduklarını görmek için giriş yapmalısın."
								: "susturduğun üyeler yüklenemedi, tekrar dene."}
						</p>
					)}
				>
					<MutedMembersList />
				</Screen>
			</div>
		</main>
	);
}
