/**
 * `FunnelPage` — the `/funnel` founder/mod conversion readout (#1589): the tracer
 * bullet for the çaylak→yazar metrics, today just the current tier population.
 *
 * Access is SERVER-authoritative — the gated `funnel.summary` read denies a non-mod
 * the invisible `UNAUTHORIZED` (`requireFunnelAccess`). The `<Screen>` catches that
 * and renders the "yetkin yok" state; no client-side authority guess decides who
 * may enter, mirroring `DivanPage`.
 */
import {FunnelSummary} from "../components/funnel/FunnelSummary";
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

/** The readout's denied / failed state — "yetkin yok" for the invisible gate. */
function AccessError({code}: {readonly code: string}) {
	const denied = code === "UNAUTHORIZED" || code === "FORBIDDEN";
	return (
		<p className="kp-funnel__error" role="alert" data-testid="funnel-access-error">
			{denied ? "bu alanı görme yetkin yok." : "dönüşüm verisi yüklenemedi, tekrar dene."}
		</p>
	);
}
