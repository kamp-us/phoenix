/**
 * Access is server-authoritative: `funnel.summary` denies a non-mod `UNAUTHORIZED`, which
 * `<Screen>` renders as "yetkin yok". Deliberately no client-side role check here.
 */
import {FunnelSummary} from "../components/funnel/FunnelSummary";
import {Alert} from "../components/ui/Alert";
import {Screen} from "../fate/Screen";
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
