/**
 * The status line: active workspace, whether the prefix is armed, and the sequence typed since it
 * armed. Every field comes off `statusFrame` (`./frame.ts`), so the page stores none of it.
 *
 * The armed prefix is announced as text in a polite live region as well as shown, because a state
 * carried only by a highlight is a state a screen-reader user never learns (Pillar 4, "never signal
 * state by colour alone").
 *
 * A `section` rather than a `footer`: an accessible name needs a role that takes one, and a `footer`
 * nested inside the desk is generic. `region` also makes the line a landmark of its own.
 */

import type {ReactElement} from "react";
import type {StatusFrame} from "./frame.ts";

export interface StatusLineProps {
	readonly frame: StatusFrame;
	readonly prefixKey: string;
}

export function StatusLine({frame, prefixKey}: StatusLineProps): ReactElement {
	return (
		<section className="tuval-status" aria-label="Shell status">
			<span>
				workspace <strong>{frame.workspace}</strong> ({frame.position.at}/{frame.position.of})
			</span>
			<span>
				{frame.windowCount} window{frame.windowCount === 1 ? "" : "s"}
				{frame.zoomed ? " · zoomed" : ""}
			</span>
			<span>
				prefix <kbd className="tuval-kbd">{prefixKey}</kbd>{" "}
				<strong>{frame.prefixArmed ? "armed" : "idle"}</strong>
			</span>
			<span>
				pending <strong>{frame.pending.length === 0 ? "—" : frame.pending.join("")}</strong>
			</span>
			<span className="tuval-refusal" role="status" aria-live="polite">
				{frame.announcement}
			</span>
		</section>
	);
}
