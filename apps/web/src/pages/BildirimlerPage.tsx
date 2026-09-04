/**
 * `/bildirimler` — ships dark behind the default-off `phoenix-bildirim` flag. The gate's shape is
 * `.patterns/flag-dark-page-gate.md`.
 */
import {Navigate} from "react-router";
import {useSession} from "../auth/client";
import {BildirimList} from "../components/bildirim/BildirimList";
import {shouldRenderBildirimPage} from "../components/bildirim/bildirim";
import {Alert} from "../components/ui/Alert";
import {Screen} from "../fate/Screen";
import {PHOENIX_BILDIRIM} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {useT} from "../i18n";
import {authRedirectPath} from "../lib/returnTo";
import {NotFoundPage} from "./NotFoundPage";
import "../components/bildirim/Bildirim.css";

export function BildirimlerPage() {
	const {value: flagOn, loading: flagLoading} = useFlag(PHOENIX_BILDIRIM, false);
	const session = useSession();
	const t = useT();

	if (flagLoading || session.isPending) {
		return (
			<div className="kp-bildirim">
				<div className="kp-bildirim__inner">
					<p className="kp-bildirim__loading">{t("bildirim.loading")}</p>
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
					<h1 className="kp-bildirim__title">{t("bildirim.title")}</h1>
				</header>
				<Screen
					fallback={<p className="kp-bildirim__loading">{t("bildirim.loading")}</p>}
					error={({code}) => (
						<Alert variant="danger" className="kp-alert--inline kp-bildirim__error">
							{t(
								code === "UNAUTHORIZED" || code === "FORBIDDEN"
									? "bildirim.error.unauthorized"
									: "bildirim.error.generic",
							)}
						</Alert>
					)}
				>
					<BildirimList />
				</Screen>
			</div>
		</main>
	);
}
