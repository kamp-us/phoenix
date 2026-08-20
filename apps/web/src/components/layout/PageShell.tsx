import type * as React from "react";
import "./PageShell.css";

// A page's vertical zone-stack: subnav above content. See ADR 0182.
export type PageShellProps = {
	subnav?: React.ReactNode;
	content?: React.ReactNode;
};

export function PageShell({subnav, content}: PageShellProps) {
	return (
		<div className="kp-page-shell">
			{subnav}
			{content}
		</div>
	);
}
