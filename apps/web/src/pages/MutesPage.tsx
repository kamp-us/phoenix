/**
 * `/susturduklarim` — ships dark behind the default-off `member-mute` flag. The gate's shape is
 * `.patterns/flag-dark-page-gate.md`.
 */
import {Navigate} from "react-router";
import {useSession} from "../auth/client";
import {MutedMembersList} from "../components/mute/MutedMembersList";
import {Alert} from "../components/ui/Alert";
import {Screen} from "../fate/Screen";
import {MEMBER_MUTE} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {authRedirectPath} from "../lib/returnTo";
import {NotFoundPage} from "./NotFoundPage";
import "./MutesPage.css";

export function MutesPage() {
	const {value: flagOn, loading: flagLoading} = useFlag(MEMBER_MUTE, false);
	const session = useSession();

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
						<Alert variant="danger" className="kp-alert--inline kp-mutes__error">
							{code === "UNAUTHORIZED" || code === "FORBIDDEN"
								? "susturduklarını görmek için giriş yapmalısın."
								: "susturduğun üyeler yüklenemedi, tekrar dene."}
						</Alert>
					)}
				>
					<MutedMembersList />
				</Screen>
			</div>
		</main>
	);
}
