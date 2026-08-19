/**
 * The `/divan` reviewer workspace. Two invariants:
 *
 * - Access is server-authoritative: `divan.roster` denies a çaylak/visitor `UNAUTHORIZED`,
 *   which `<Screen>` renders as "yetkin yok". Deliberately no client-side role check.
 * - It reads ONLY the `sandboxBacklogWhere` destination, never the inline `{mod, author}`
 *   filter, so çaylak work stays visible only inside the divan.
 */
import {useEffect, useState} from "react";
import {useMe} from "../auth/useMe";
import {CaylakDetail} from "../components/divan/CaylakDetail";
import {DecisionFeed} from "../components/divan/DecisionFeed";
import {DivanRoster} from "../components/divan/DivanRoster";
import {useSetDivanSubnavContent} from "../components/divan/DivanSubnavLayout";
import {Raporlar} from "../components/divan/Raporlar";
import {TriageLoop} from "../components/divan/TriageLoop";
import type {SubnavFilter} from "../components/layout/Subnav";
import {Alert} from "../components/ui/Alert";
import {Button} from "../components/ui/Button";
import {Screen} from "../fate/Screen";
import "../components/divan/Divan.css";

const DIVAN_SECTION_FILTERS: SubnavFilter[] = [
	{id: "caylaklar", label: "çaylaklar"},
	{id: "raporlar", label: "raporlar"},
];

export function DivanPage() {
	return <DivanWorkspace />;
}

function DivanWorkspace() {
	const {me} = useMe();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	// Gate raporlar on the server-side isModerator signal, never on tier.
	const raporlarVisible = me?.isModerator ?? false;
	const [section, setSection] = useState<"caylaklar" | "raporlar">("caylaklar");
	const showRaporlarPane = raporlarVisible && section === "raporlar";
	// The loop is the product, the grid its Esc fallback — see ADR 0138.
	const [raporlarMode, setRaporlarMode] = useState<"loop" | "grid">("loop");

	// The page owns the switch state, so it publishes the switchers UP into divan's persistent
	// Subnav zone. No zone ancestor ⇒ setter null ⇒ the in-page nav below renders instead.
	const setDivanSubnav = useSetDivanSubnavContent();
	const inZone = setDivanSubnav != null;

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
						<Button
							type="button"
							variant="tertiary"
							size="sm"
							className="kp-divan__nav-tab"
							aria-current={section === "caylaklar" ? "true" : undefined}
							onClick={() => setSection("caylaklar")}
							data-testid="divan-nav-caylaklar"
						>
							çaylaklar
						</Button>
						<Button
							type="button"
							variant="tertiary"
							size="sm"
							className="kp-divan__nav-tab"
							aria-current={section === "raporlar" ? "true" : undefined}
							onClick={() => {
								setSection("raporlar");
								setRaporlarMode("loop");
							}}
							data-testid="divan-nav-raporlar"
						>
							raporlar
						</Button>
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

function AccessError({code}: {readonly code: string}) {
	const denied = code === "UNAUTHORIZED" || code === "FORBIDDEN";
	return (
		<Alert
			variant="danger"
			className="kp-alert--inline kp-divan__error"
			data-testid="divan-access-error"
		>
			{denied ? "bu alanı görme yetkin yok." : "divan yüklenemedi, tekrar dene."}
		</Alert>
	);
}
