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
 *
 * The moderator-only raporlar section (#1701) sits inside this workspace, shown
 * only for the trusted server-side `isModerator` signal — see `Raporlar.tsx`.
 */
import {useEffect, useState} from "react";
import {useMe} from "../auth/useMe";
import {CaylakDetail} from "../components/divan/CaylakDetail";
import {DecisionFeed} from "../components/divan/DecisionFeed";
import {DivanRoster} from "../components/divan/DivanRoster";
import {useSetDivanSubnavContent} from "../components/divan/DivanSubnavLayout";
import {shouldRenderDivanPage} from "../components/divan/divanGating";
import {Raporlar} from "../components/divan/Raporlar";
import {TriageLoop} from "../components/divan/TriageLoop";
import type {SubnavFilter} from "../components/layout/Subnav";
import {Screen} from "../fate/Screen";
import {PHOENIX_AUTHORSHIP_LOOP, PHOENIX_NAV_IA} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {NotFoundPage} from "./NotFoundPage";
import "../components/divan/Divan.css";

// The çaylaklar ↔ raporlar section switch as Subnav filters (#2604): when the nav-IA zone is
// mounted, the switch is published up to the persistent divan Subnav rather than painted in-page.
const DIVAN_SECTION_FILTERS: SubnavFilter[] = [
	{id: "caylaklar", label: "çaylaklar"},
	{id: "raporlar", label: "raporlar"},
];

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
	// The raporlar (moderation-queue) entry (#1701): rendered only for the trusted
	// server-side isModerator signal — never tier — so for a non-mod viewer /divan is
	// exactly the çaylak workspace. The server stays authoritative: report.listOpen
	// denies a forced non-mod read the invisible UNAUTHORIZED, caught by <Screen> below.
	const raporlarVisible = me?.isModerator ?? false;
	const [section, setSection] = useState<"caylaklar" | "raporlar">("caylaklar");
	const showRaporlarPane = raporlarVisible && section === "raporlar";
	// The triage loop is the product; the grid is its Esc fallback (#1703, ADR 0138).
	// Entering the raporlar section always starts in the loop; Esc's outermost rung
	// de-escalates to the grid without leaving the section.
	const [raporlarMode, setRaporlarMode] = useState<"loop" | "grid">("loop");

	// nav-IA (#2604, epic #2596): with the flag on, the section switch lives in divan's persistent
	// Subnav zone. The page owns the switch state (roster vs raporlar pane below), so it publishes
	// the switchers UP to the zone (the pano publish-up shape) and drops its own in-page nav. Only a
	// moderator has a second section, so a non-mod viewer publishes null (a bare Subnav bar). Off ⇒
	// no zone ancestor ⇒ setter null ⇒ the in-page nav renders exactly as today.
	const {value: navIaOn} = useFlag(PHOENIX_NAV_IA, false);
	const setDivanSubnav = useSetDivanSubnavContent();
	const inZone = navIaOn && setDivanSubnav != null;

	useEffect(() => {
		if (!inZone || !setDivanSubnav) return;
		setDivanSubnav(
			raporlarVisible
				? {
						filters: DIVAN_SECTION_FILTERS,
						activeFilter: section,
						onFilterChange: (id) => {
							if (id === "raporlar") {
								setSection("raporlar");
								setRaporlarMode("loop");
							} else {
								setSection("caylaklar");
							}
						},
					}
				: null,
		);
	}, [inZone, setDivanSubnav, raporlarVisible, section]);
	// Clear the zone's content on unmount, so the persistent zone falls back to the bare bar.
	useEffect(() => {
		return () => setDivanSubnav?.(null);
	}, [setDivanSubnav]);

	return (
		<div className="kp-divan" data-testid="divan-page">
			<div className="kp-divan__inner">
				<header className="kp-divan__masthead">
					<h1 className="kp-divan__title">divan</h1>
					<p className="kp-divan__lead">
						çaylakların ürettiklerini burada değerlendirirsin. en çok üreten, en az incelenmiş
						çaylaklar üstte.
					</p>
				</header>

				{!inZone && raporlarVisible && (
					<nav className="kp-divan__nav" aria-label="divan bölümleri">
						<button
							type="button"
							className="kp-divan__nav-tab"
							aria-current={section === "caylaklar" ? "true" : undefined}
							onClick={() => setSection("caylaklar")}
							data-testid="divan-nav-caylaklar"
						>
							çaylaklar
						</button>
						<button
							type="button"
							className="kp-divan__nav-tab"
							aria-current={section === "raporlar" ? "true" : undefined}
							onClick={() => {
								setSection("raporlar");
								setRaporlarMode("loop");
							}}
							data-testid="divan-nav-raporlar"
						>
							raporlar
						</button>
					</nav>
				)}

				{showRaporlarPane ? (
					<>
						<section className="kp-divan__raporlar-pane" aria-label="açık raporlar">
							<Screen
								fallback={<p className="kp-divan__loading">yükleniyor…</p>}
								error={({code}) => <AccessError code={code} />}
							>
								{raporlarMode === "loop" ? (
									<TriageLoop onExit={() => setRaporlarMode("grid")} />
								) : (
									<Raporlar />
								)}
							</Screen>
						</section>

						{/* The shared decision feed (#1704) — a DISTINCT section, its own gated
						    read, so who-decided-what stays legible below the live queue. */}
						<section className="kp-divan__decisions-pane" aria-label="son kararlar">
							<h2 className="kp-divan__decisions-title">son kararlar</h2>
							<Screen
								fallback={<p className="kp-divan__loading">yükleniyor…</p>}
								error={({code}) => <AccessError code={code} />}
							>
								<DecisionFeed />
							</Screen>
						</section>
					</>
				) : (
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
				)}
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
