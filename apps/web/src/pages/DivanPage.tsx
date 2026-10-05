/**
 * The `/divan` reviewer workspace. Two invariants:
 *
 * - Access is server-authoritative: `divan.roster` denies a çaylak/visitor `UNAUTHORIZED`,
 *   which `<Screen>` renders as "yetkin yok". Deliberately no client-side role check.
 * - It reads ONLY the `sandboxBacklogWhere` destination, never the inline `{mod, author}`
 *   filter, so çaylak work stays visible only inside the divan.
 *
 * The section comes from the route, never from component state (#8776): `/divan` is the
 * roster and `/divan/raporlar` the reports pane, so both panes are addressable by URL and
 * the switch survives a reload. `divanSection.ts` owns the resolution, including the
 * moderator fold.
 */

import {Alert, Button} from "@kampus/design";
import {useCallback, useEffect, useMemo, useState} from "react";
import {useNavigate} from "react-router";
import {useMe} from "../auth/useMe";
import {CaylakDetail} from "../components/divan/CaylakDetail";
import {DecisionFeed} from "../components/divan/DecisionFeed";
import {DivanRoster} from "../components/divan/DivanRoster";
import {useSetDivanSubnavContent} from "../components/divan/DivanSubnavLayout";
import {
	type DivanSection,
	divanSectionFromFilterId,
	divanSectionHref,
	visibleDivanSection,
} from "../components/divan/divanSection";
import {Raporlar} from "../components/divan/Raporlar";
import {TriageLoop} from "../components/divan/TriageLoop";
import type {SubnavFilter} from "../components/layout/Subnav";
import {Screen} from "../fate/Screen";
import {type CatalogKey, useT} from "../i18n";
import "../components/divan/Divan.css";

const DIVAN_SECTION_KEYS: ReadonlyArray<{readonly id: string; readonly labelKey: CatalogKey}> = [
	{id: "caylaklar", labelKey: "divan.nav.caylaklar"},
	{id: "raporlar", labelKey: "divan.nav.raporlar"},
];

/**
 * `section` is supplied by the route that mounted the page — `App.tsx` mounts `/divan`
 * plainly and `/divan/raporlar` with `section="raporlar"`, so no path parsing lives here.
 */
export function DivanPage({section = "caylaklar"}: {readonly section?: DivanSection}) {
	return <DivanWorkspace routeSection={section} />;
}

function DivanWorkspace({routeSection}: {readonly routeSection: DivanSection}) {
	const t = useT();
	const navigate = useNavigate();
	const {me} = useMe();
	// The open çaylak carries the roster row's viewer-scoped `viewerVouched` with it, so the
	// detail's "kefil oldun" state comes off the roster's batched read rather than a second
	// by-id read of that çaylak (#7373, ADR 0021).
	const [selected, setSelected] = useState<{
		readonly authorId: string;
		readonly viewerVouched: boolean;
	} | null>(null);
	const selectedId = selected?.authorId ?? null;
	// Gate raporlar on the server-side isModerator signal, never on tier.
	const raporlarVisible = me?.isModerator ?? false;
	const section = visibleDivanSection(routeSection, raporlarVisible);
	const showRaporlarPane = section === "raporlar";
	// The loop is the product, the grid its Esc fallback — see ADR 0138.
	const [raporlarMode, setRaporlarMode] = useState<"loop" | "grid">("loop");
	// Switching sections is a navigation, so a shared link and a reload both land back here.
	const goToSection = useCallback(
		(next: DivanSection) => {
			if (next === "raporlar") setRaporlarMode("loop");
			navigate(divanSectionHref(next));
		},
		[navigate],
	);

	// The page knows which section is live, so it publishes the switchers UP into divan's
	// persistent Subnav zone. No zone ancestor ⇒ setter null ⇒ the in-page nav below renders
	// instead.
	const setDivanSubnav = useSetDivanSubnavContent();
	const inZone = setDivanSubnav != null;

	const sectionFilters = useMemo<SubnavFilter[]>(
		() => DIVAN_SECTION_KEYS.map(({id, labelKey}) => ({id, label: t(labelKey)})),
		[t],
	);

	useEffect(() => {
		if (!inZone || !setDivanSubnav) return;
		setDivanSubnav(
			raporlarVisible
				? {
						filters: sectionFilters,
						activeFilter: section,
						onFilterChange: (id) => goToSection(divanSectionFromFilterId(id)),
					}
				: null,
		);
	}, [inZone, setDivanSubnav, raporlarVisible, section, sectionFilters, goToSection]);
	useEffect(() => {
		return () => setDivanSubnav?.(null);
	}, [setDivanSubnav]);

	return (
		<div className="kp-divan" data-testid="divan-page">
			<div className="kp-divan__inner">
				<header className="kp-divan__masthead">
					<h1 className="kp-divan__title">{t("divan.title")}</h1>
					<p className="kp-divan__lead">{t("divan.lead")}</p>
				</header>

				{!inZone && raporlarVisible && (
					<nav className="kp-divan__nav" aria-label={t("divan.nav.label")}>
						<Button
							type="button"
							variant="tertiary"
							size="sm"
							className="kp-divan__nav-tab"
							aria-current={section === "caylaklar" ? "true" : undefined}
							onClick={() => goToSection("caylaklar")}
							data-testid="divan-nav-caylaklar"
						>
							{t("divan.nav.caylaklar")}
						</Button>
						<Button
							type="button"
							variant="tertiary"
							size="sm"
							className="kp-divan__nav-tab"
							aria-current={section === "raporlar" ? "true" : undefined}
							onClick={() => goToSection("raporlar")}
							data-testid="divan-nav-raporlar"
						>
							{t("divan.nav.raporlar")}
						</Button>
					</nav>
				)}

				{showRaporlarPane ? (
					<>
						<section className="kp-divan__raporlar-pane" aria-label={t("divan.raporlar.label")}>
							<Screen
								fallback={<p className="kp-divan__loading">{t("divan.loading")}</p>}
								error={({code}) => <AccessError code={code} />}
							>
								{raporlarMode === "loop" ? (
									<TriageLoop onExit={() => setRaporlarMode("grid")} />
								) : (
									<Raporlar />
								)}
							</Screen>
						</section>

						<section className="kp-divan__decisions-pane" aria-label={t("divan.decisions.label")}>
							<h2 className="kp-divan__decisions-title">{t("divan.decisions.label")}</h2>
							<Screen
								fallback={<p className="kp-divan__loading">{t("divan.loading")}</p>}
								error={({code}) => <AccessError code={code} />}
							>
								<DecisionFeed />
							</Screen>
						</section>
					</>
				) : (
					<div className="kp-divan__layout">
						<section className="kp-divan__roster-pane" aria-label={t("divan.roster.paneLabel")}>
							<Screen
								fallback={<p className="kp-divan__loading">{t("divan.loading")}</p>}
								error={({code}) => <AccessError code={code} />}
							>
								<DivanRoster
									selectedId={selectedId}
									onSelect={(authorId, viewerVouched) => setSelected({authorId, viewerVouched})}
								/>
							</Screen>
						</section>

						<section className="kp-divan__detail-pane" aria-label={t("divan.detail.label")}>
							{selected === null ? (
								<p className="kp-divan__hint" data-testid="divan-detail-hint">
									{t("divan.detail.hint")}
								</p>
							) : (
								<Screen
									key={selectedId}
									fallback={<p className="kp-divan__loading">{t("divan.loading")}</p>}
									error={({code}) => <AccessError code={code} />}
								>
									<CaylakDetail
										authorId={selected.authorId}
										viewerTier={me?.tier}
										viewerIsModerator={me?.isModerator ?? false}
										viewerVouched={selected.viewerVouched}
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
	const t = useT();
	const denied = code === "UNAUTHORIZED" || code === "FORBIDDEN";
	return (
		<Alert
			variant="danger"
			className="kp-alert--inline kp-divan__error"
			data-testid="divan-access-error"
		>
			{denied ? t("divan.error.denied") : t("divan.error.load")}
		</Alert>
	);
}
