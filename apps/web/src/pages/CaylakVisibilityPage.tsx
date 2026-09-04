/**
 * `CaylakVisibilityPage` — the `/caylak-gorunurlugu` route (#6426, epic #4306): the yazar's
 * "çaylak katkılarını yerinde göster" setting, and the only surface that flips the #6422
 * preference. Same shape as `MutesPage` (`/susturduklarim`, #3117): a signed-in per-user
 * preference route that redirects a signed-out visitor to auth with a `returnTo`.
 *
 * Ships dark behind `phoenix-caylak-visibility` (default-off;
 * `.patterns/flag-dark-page-gate.md`). Yazar-only: a signed-in çaylak gets
 * a plain explanation, never a switch they cannot flip — the server refuses them anyway (#6422),
 * so a disabled control would only be a dead end wearing a control's clothes. Which of the six
 * states renders is the pure {@link caylakVisibilityGate}.
 */
import {Navigate} from "react-router";
import {useSession} from "../auth/client";
import {useMe} from "../auth/useMe";
import {CaylakVisibilitySetting} from "../components/caylak-visibility/CaylakVisibilityToggle";
import {Alert} from "../components/ui/Alert";
import {Screen} from "../fate/Screen";
import {PHOENIX_CAYLAK_VISIBILITY} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {useT} from "../i18n";
import {authRedirectPath} from "../lib/returnTo";
import {caylakVisibilityGate} from "./caylakVisibilityGating";
import {NotFoundPage} from "./NotFoundPage";
import "./CaylakVisibilityPage.css";

export const CAYLAK_VISIBILITY_PATH = "/caylak-gorunurlugu";

export function CaylakVisibilityPage() {
	const {value: flagOn, loading: flagLoading} = useFlag(PHOENIX_CAYLAK_VISIBILITY, false);
	const session = useSession();
	const {me, status: meStatus} = useMe();
	const t = useT();

	const gate = caylakVisibilityGate({
		flagOn,
		flagLoading,
		sessionPending: session.isPending,
		signedIn: !!session.data?.user,
		tier: me?.tier,
		meFailed: meStatus === "error",
	});

	if (gate === "loading") {
		return (
			<div className="kp-caylak-visibility">
				<div className="kp-caylak-visibility__inner">
					<p className="kp-caylak-visibility__loading" data-testid="caylak-visibility-loading">
						{t("caylakVisibility.page.loading")}
					</p>
				</div>
			</div>
		);
	}

	if (gate === "not-found") return <NotFoundPage />;

	if (gate === "sign-in") {
		return <Navigate to={authRedirectPath(CAYLAK_VISIBILITY_PATH)} replace />;
	}

	return (
		<main className="kp-caylak-visibility" data-testid="caylak-visibility-page">
			<div className="kp-caylak-visibility__inner">
				<header className="kp-caylak-visibility__masthead">
					<h1 className="kp-caylak-visibility__title">{t("caylakVisibility.page.title")}</h1>
					<p className="kp-caylak-visibility__lede">{t("caylakVisibility.page.lede")}</p>
				</header>

				{gate === "unavailable" ? (
					<Alert
						variant="danger"
						className="kp-alert--inline kp-caylak-visibility__error"
						data-testid="caylak-visibility-unavailable"
					>
						{t("caylakVisibility.page.unavailable")}
					</Alert>
				) : null}

				{gate === "caylak" ? (
					<p className="kp-caylak-visibility__note" data-testid="caylak-visibility-caylak-note">
						{t("caylakVisibility.page.caylakNote")}
					</p>
				) : null}

				{gate === "toggle" ? (
					<Screen
						fallback={
							<p className="kp-caylak-visibility__loading">{t("caylakVisibility.page.loading")}</p>
						}
						error={() => (
							<Alert
								variant="danger"
								className="kp-alert--inline kp-caylak-visibility__error"
								data-testid="caylak-visibility-read-error"
							>
								{t("caylakVisibility.page.unavailable")}
							</Alert>
						)}
					>
						<CaylakVisibilitySetting />
					</Screen>
				) : null}
			</div>
		</main>
	);
}
