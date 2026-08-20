import {Navigate} from "react-router";
import {useSession} from "../auth/client";
import {BildirimList} from "../components/bildirim/BildirimList";
import {shouldRenderBildirimPage} from "../components/bildirim/bildirim";
import {Alert} from "../components/ui/Alert";
import {Screen} from "../fate/Screen";
import {PHOENIX_BILDIRIM} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {authRedirectPath} from "../lib/returnTo";
import {NotFoundPage} from "./NotFoundPage";
import "../components/bildirim/Bildirim.css";

export function BildirimlerPage() {
	const {value: flagOn, loading: flagLoading} = useFlag(PHOENIX_BILDIRIM, false);
	const session = useSession();

	// Don't decide 404-vs-page until the flag resolves, or the 404 flashes first.
	if (flagLoading || session.isPending) {
		return (
			<div className="kp-bildirim">
				<div className="kp-bildirim__inner">
					<p className="kp-bildirim__loading">yükleniyor…</p>
				</div>
			</div>
		);
	}

	if (!shouldRenderBildirimPage(flagOn)) return <NotFoundPage />;

	if (!session.data?.user) {
		return <Navigate to={authRedirectPath("/bildirimler")} replace />;
	}

	return (
		<main className="kp-bildirim" data-testid="bildirim-page">
			<div className="kp-bildirim__inner">
				<header className="kp-bildirim__masthead">
					<h1 className="kp-bildirim__title">bildirimler</h1>
				</header>
				<Screen
					fallback={<p className="kp-bildirim__loading">yükleniyor…</p>}
					error={({code}) => (
						<Alert variant="danger" className="kp-alert--inline kp-bildirim__error">
							{code === "UNAUTHORIZED" || code === "FORBIDDEN"
								? "bildirimlerini görmek için giriş yapmalısın."
								: "bildirimler yüklenemedi, tekrar dene."}
						</Alert>
					)}
				>
					<BildirimList />
				</Screen>
			</div>
		</main>
	);
}
