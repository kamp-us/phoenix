/**
 * Access is server-authoritative: `funnel.summary` denies a non-mod `UNAUTHORIZED`, which
 * `<Screen>` renders as "yetkin yok". Deliberately no client-side role check here.
 */
import {FunnelCohorts} from "../components/funnel/FunnelCohorts";
import {FunnelSummary} from "../components/funnel/FunnelSummary";
import {Alert} from "../components/ui/Alert";
import {Screen} from "../fate/Screen";
import {FlagGate} from "../flags/FlagGate";
import {PHOENIX_FUNNEL_COHORT} from "../flags/keys";
import {useT} from "../i18n";
import "../components/funnel/Funnel.css";

export function FunnelPage() {
	const t = useT();
	return (
		<main className="kp-funnel" data-testid="funnel-page">
			<div className="kp-funnel__inner">
				<header className="kp-funnel__masthead">
					<h1 className="kp-funnel__title">{t("divan.funnel.title")}</h1>
					<p className="kp-funnel__lead">{t("divan.funnel.lead")}</p>
				</header>

				<section className="kp-funnel__panel" aria-label={t("divan.funnel.tierLabel")}>
					<Screen
						fallback={<p className="kp-funnel__loading">{t("divan.loading")}</p>}
						error={({code}) => <AccessError code={code} />}
					>
						<FunnelSummary />
					</Screen>
				</section>

				{/* The cohort display gates on BOTH sides of the wire (founder ruling R1.2 on
				    #7028): the resolvers resolve behind `phoenix-funnel-cohort`, and this client
				    gate keeps the section — requests included — out of the DOM entirely while the
				    flag is off, so the page stays byte-identical to the pool readout. */}
				<FlagGate flag={PHOENIX_FUNNEL_COHORT}>
					<section aria-label={t("divan.funnel.cohorts.label")}>
						<Screen
							fallback={<p className="kp-funnel__loading">{t("divan.loading")}</p>}
							error={({code}) => <AccessError code={code} />}
						>
							<FunnelCohorts />
						</Screen>
					</section>
				</FlagGate>
			</div>
		</main>
	);
}

function AccessError({code}: {readonly code: string}) {
	const t = useT();
	const denied = code === "UNAUTHORIZED" || code === "FORBIDDEN";
	return (
		<Alert
			variant="danger"
			className="kp-alert--inline kp-funnel__error"
			data-testid="funnel-access-error"
		>
			{denied ? t("divan.error.denied") : t("divan.funnel.errorLoad")}
		</Alert>
	);
}
