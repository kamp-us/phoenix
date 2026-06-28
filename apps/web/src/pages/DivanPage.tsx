/**
 * `DivanPage` — the `/divan` reviewer workspace (#1290, epic #1202): the
 * yazar/mod proving ground where a çaylak's sandboxed work is reviewed toward
 * promotion. The whole surface ships dark behind the `phoenix-authorship-loop`
 * flag (#1204): with the flag off the route renders the 404 (effectively absent);
 * loading shows a neutral placeholder so the 404 never flashes before the flag
 * resolves.
 *
 * Access is SERVER-authoritative — the gated `divan.roster` read denies a
 * çaylak/visitor the invisible `UNAUTHORIZED` (`requireDivanAccess`, yazar OR
 * mod). The roster's `<Screen>` catches that and renders the "yetkin yok" state;
 * no client-side authority guess decides who may enter.
 *
 * It reads ONLY the `sandboxBacklogWhere` DESTINATION (roster + per-çaylak
 * backlog) — never the inline `{mod, author}` filter — so çaylak work stays
 * one-way glass, visible only inside the divan.
 */
import {useState} from "react";
import {useMe} from "../auth/useMe";
import {CaylakDetail} from "../components/divan/CaylakDetail";
import {DivanRoster} from "../components/divan/DivanRoster";
import {shouldRenderDivanPage} from "../components/divan/divanGating";
import {Screen} from "../fate/Screen";
import {PHOENIX_AUTHORSHIP_LOOP} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {NotFoundPage} from "./NotFoundPage";
import "../components/divan/Divan.css";

export function DivanPage() {
	const {value: flagOn, loading: flagLoading} = useFlag(PHOENIX_AUTHORSHIP_LOOP, false);

	// Don't decide 404-vs-page until the flag resolves, or the 404 flashes first.
	if (flagLoading) {
		return (
			<div className="kp-divan">
				<div className="kp-divan__inner">
					<p className="kp-divan__loading">yükleniyor…</p>
				</div>
			</div>
		);
	}

	if (!shouldRenderDivanPage(flagOn)) return <NotFoundPage />;

	return <DivanWorkspace />;
}

function DivanWorkspace() {
	const {me} = useMe();
	const [selectedId, setSelectedId] = useState<string | null>(null);

	return (
		<div className="kp-divan" data-testid="divan-page">
			<div className="kp-divan__inner">
				<header className="kp-divan__masthead">
					<h1 className="kp-divan__title">divan</h1>
					<p className="kp-divan__lead">
						çaylakların incelemedeki katkılarını burada değerlendirirsin. en çok katkı veren, en az
						incelenen çaylaklar üstte.
					</p>
				</header>

				<div className="kp-divan__layout">
					<section className="kp-divan__roster-pane" aria-label="çaylak listesi">
						<Screen
							fallback={<p className="kp-divan__loading">yükleniyor…</p>}
							error={({code}) => <AccessError code={code} />}
						>
							<DivanRoster selectedId={selectedId} onSelect={setSelectedId} />
						</Screen>
					</section>

					<section className="kp-divan__detail-pane" aria-label="çaylak incelemesi">
						{selectedId === null ? (
							<p className="kp-divan__hint" data-testid="divan-detail-hint">
								incelemek için bir çaylak seç.
							</p>
						) : (
							<Screen
								key={selectedId}
								fallback={<p className="kp-divan__loading">yükleniyor…</p>}
								error={({code}) => <AccessError code={code} />}
							>
								<CaylakDetail
									authorId={selectedId}
									viewerTier={me?.tier}
									viewerIsModerator={me?.isModerator ?? false}
								/>
							</Screen>
						)}
					</section>
				</div>
			</div>
		</div>
	);
}

/** The divan's denied / failed read state — "yetkin yok" for the invisible gate. */
function AccessError({code}: {readonly code: string}) {
	const denied = code === "UNAUTHORIZED" || code === "FORBIDDEN";
	return (
		<p className="kp-divan__error" role="alert" data-testid="divan-access-error">
			{denied ? "bu alanı görme yetkin yok." : "divan yüklenemedi, tekrar dene."}
		</p>
	);
}
