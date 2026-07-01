/**
 * `FunnelPage` — the `/funnel` founder/mod conversion readout (#1589): the tracer
 * bullet for the çaylak→yazar metrics, today just the current tier population. The
 * whole surface ships dark behind the `phoenix-funnel-readout` flag: with the flag
 * off the route renders the 404 (effectively absent); loading shows a neutral
 * placeholder so the 404 never flashes before the flag resolves.
 *
 * Access is SERVER-authoritative — the gated `funnel.summary` read denies a non-mod
 * the invisible `UNAUTHORIZED` (`requireFunnelAccess`). The `<Screen>` catches that
 * and renders the "yetkin yok" state; no client-side authority guess decides who
 * may enter, mirroring `DivanPage`.
 */
import {FunnelSummary} from "../components/funnel/FunnelSummary";
import {shouldRenderFunnelPage} from "../components/funnel/funnelGating";
import {Screen} from "../fate/Screen";
import {PHOENIX_FUNNEL_READOUT} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {NotFoundPage} from "./NotFoundPage";
import "../components/funnel/Funnel.css";

export function FunnelPage() {
	const {value: flagOn, loading: flagLoading} = useFlag(PHOENIX_FUNNEL_READOUT, false);

	// Don't decide 404-vs-page until the flag resolves, or the 404 flashes first.
	if (flagLoading) {
		return (
			<div className="kp-funnel">
				<div className="kp-funnel__inner">
					<p className="kp-funnel__loading">yükleniyor…</p>
				</div>
			</div>
		);
	}

	if (!shouldRenderFunnelPage(flagOn)) return <NotFoundPage />;

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
