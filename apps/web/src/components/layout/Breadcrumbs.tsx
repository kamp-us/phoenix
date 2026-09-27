import type {ReactNode} from "react";
import {useT} from "../../i18n";
import "./Breadcrumbs.css";

export interface Crumb {
	readonly key: string;
	readonly label: ReactNode;
}

export interface BreadcrumbsProps {
	/** The caller's row class; it keeps owning how the row looks. */
	readonly className?: string;
	/** The ancestors, root first. */
	readonly trail: readonly [Crumb, ...Crumb[]];
	/** The page the reader is on. Absent when the row stops above the page, as the letter page's does. */
	readonly current?: Crumb;
}

/**
 * The WAI-ARIA breadcrumb pattern: a named `nav` around an ordered list, the `/` separators
 * hidden from assistive tech, and `aria-current="page"` on the page's own crumb only.
 */
export function Breadcrumbs({className, trail, current}: BreadcrumbsProps) {
	const t = useT();
	return (
		<nav className={className} aria-label={t("layout.breadcrumb.label")}>
			<ol className="kp-breadcrumbs">
				{trail.map((crumb, index) => (
					<CrumbItem key={crumb.key} crumb={crumb} first={index === 0} current={false} />
				))}
				{current ? <CrumbItem crumb={current} first={false} current /> : null}
			</ol>
		</nav>
	);
}

function CrumbItem({crumb, first, current}: {crumb: Crumb; first: boolean; current: boolean}) {
	return (
		<li className="kp-breadcrumbs__item" aria-current={current ? "page" : undefined}>
			{first ? null : (
				<span className="kp-breadcrumbs__sep" aria-hidden="true">
					{" / "}
				</span>
			)}
			{crumb.label}
		</li>
	);
}
