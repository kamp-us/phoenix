import type * as React from "react";
import {useT} from "../../i18n";
import "./AppShell.css";

export function AppShell({children}: {children: React.ReactNode}) {
	const t = useT();
	return (
		<div className="manti-app kp-shell">
			{/* First focusable element in the DOM — href="#main" moves focus to the
			    tabindex=-1 <main> landmark, letting keyboard users skip the chrome. */}
			<a className="kp-skip-link" href="#main">
				{t("layout.skipToContent")}
			</a>
			{children}
		</div>
	);
}

export function Main({children}: {children: React.ReactNode}) {
	return (
		<main id="main" tabIndex={-1} className="kp-shell__main">
			{children}
		</main>
	);
}
