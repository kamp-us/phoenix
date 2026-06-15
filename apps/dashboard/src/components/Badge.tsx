import "./Badge.css";

/**
 * A small label chip for an issue's `type:*` / `p*`. `tone` drives the color via a
 * data attribute the CSS keys off, so a missing facet renders nothing rather than a
 * blank chip.
 */
export function Badge({tone, children}: {tone: string; children: string}) {
	return (
		<span className="qb-badge" data-tone={tone}>
			{children}
		</span>
	);
}
