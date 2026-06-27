import type * as React from "react";
import "./AppShell.css";

export function AppShell({children}: {children: React.ReactNode}) {
	return (
		<div className="kp-shell">
			{/* First focusable element in the DOM — href="#main" moves focus to the
			    tabindex=-1 <main> landmark, letting keyboard users skip the chrome. */}
			<a className="kp-skip-link" href="#main">
				içeriğe geç
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
