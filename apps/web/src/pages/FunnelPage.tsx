/**
 * Access is server-authoritative: `funnel.summary` denies a non-mod `UNAUTHORIZED`, which
 * `<Screen>` renders as "yetkin yok". Deliberately no client-side role check here.
 */

import {Alert} from "@kampus/design";
import {FunnelCohorts} from "../components/funnel/FunnelCohorts";
import {FunnelSummary} from "../components/funnel/FunnelSummary";
import {Screen} from "../fate/Screen";
import {FlagGate} from "../flags/FlagGate";
import {PHOENIX_FUNNEL_COHORT} from "../flags/keys";
import "../components/funnel/Funnel.css";

export function FunnelPage() {
	return (
		<main className="kp-funnel" data-testid="funnel-page">
			<div className="kp-funnel__inner">
				<header className="kp-funnel__masthead">
					<h1 className="kp-funnel__title">dönüşüm</h1>
					<p className="kp-funnel__lead">
						çaylaktan yazara geçiş hunisi. şu an platformdaki insan hesapların tier dağılımı.
					</p>
				</header>

				<section className="kp-funnel__panel" aria-label="tier dağılımı">
					<Screen
						fallback={<p className="kp-funnel__loading">yükleniyor…</p>}
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
					<section aria-label="kozet hunisi">
						<Screen
							fallback={<p className="kp-funnel__loading">yükleniyor…</p>}
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
	const denied = code === "UNAUTHORIZED" || code === "FORBIDDEN";
	return (
		<Alert
			variant="danger"
			className="kp-alert--inline kp-funnel__error"
			data-testid="funnel-access-error"
		>
			{denied ? "bu alanı görme yetkin yok." : "dönüşüm verisi yüklenemedi, tekrar dene."}
		</Alert>
	);
}
