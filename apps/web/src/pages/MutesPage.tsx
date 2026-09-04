/**
 * `/susturduklarim` — ships dark behind the default-off `member-mute` flag. The gate's shape is
 * `.patterns/flag-dark-page-gate.md`.
 */

import {Alert} from "@kampus/design";
import {Navigate} from "react-router";
import {useSession} from "../auth/client";
import {MutedMembersList} from "../components/mute/MutedMembersList";
import {Screen} from "../fate/Screen";
import {MEMBER_MUTE} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {useT} from "../i18n";
import {authRedirectPath} from "../lib/returnTo";
import {NotFoundPage} from "./NotFoundPage";
import "./MutesPage.css";

export function MutesPage() {
	const {value: flagOn, loading: flagLoading} = useFlag(MEMBER_MUTE, false);
	const session = useSession();
	const t = useT();

	if (flagLoading || session.isPending) {
		return (
			<div className="kp-mutes">
				<div className="kp-mutes__inner">
					<p className="kp-mutes__loading">{t("mute.page.loading")}</p>
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
					<h1 className="kp-mutes__title">{t("mute.page.title")}</h1>
					<p className="kp-mutes__lede">{t("mute.page.lede")}</p>
				</header>
				<Screen
					fallback={<p className="kp-mutes__loading">{t("mute.page.loading")}</p>}
					error={({code}) => (
						<Alert variant="danger" className="kp-alert--inline kp-mutes__error">
							{t(
								code === "UNAUTHORIZED" || code === "FORBIDDEN"
									? "mute.page.error.unauthorized"
									: "mute.page.error.generic",
							)}
						</Alert>
					)}
				>
					<MutedMembersList />
				</Screen>
			</div>
		</main>
	);
}
