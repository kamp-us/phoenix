/**
 * The divan's section switch, resolved DOM-free (#8776). The section used to be plain
 * component state, so raporlar was reachable only by an in-page click — a renderer that
 * only navigates could never paint `.kp-divan__raporlar-pane` or
 * `.kp-divan__decisions-pane`, and no moderator could link or reload into them.
 *
 * The URL now carries the section and this module is the one place that reads it back.
 * {@link visibleDivanSection} keeps the moderator gate where it already was: it folds a
 * raporlar URL down to `caylaklar` for a viewer the server has not called a moderator, so
 * the pane's visibility stays keyed on `isModerator` rather than on the path.
 */

export type DivanSection = "caylaklar" | "raporlar";

export const DIVAN_PATH = "/divan";
export const DIVAN_RAPORLAR_PATH = "/divan/raporlar";

export function divanSectionHref(section: DivanSection): string {
	return section === "raporlar" ? DIVAN_RAPORLAR_PATH : DIVAN_PATH;
}

/**
 * Which section actually renders. `isModerator` is the server's signal read off `me`, and
 * it is `false` while `me` is still unread — so a moderator's direct navigation paints
 * `caylaklar` for that first frame and flips once the read lands. That is why the fold is a
 * render decision and not a redirect: a redirect would spend the moderator's own URL on the
 * loading frame.
 */
export function visibleDivanSection(
	routeSection: DivanSection,
	isModerator: boolean,
): DivanSection {
	return routeSection === "raporlar" && isModerator ? "raporlar" : "caylaklar";
}

/** The Subnav zone's filter ids are plain strings; anything but raporlar is the roster. */
export function divanSectionFromFilterId(id: string): DivanSection {
	return id === "raporlar" ? "raporlar" : "caylaklar";
}
