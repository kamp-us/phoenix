/**
 * The status line: three groups, and which of them a program can reach is the whole point.
 *
 * `statusFor` (`../desk/compose.ts`) hands over a composed `StatusBar` whose `left` and `right` it
 * derived itself and whose `middle` is whatever the focused window's program returned. This binds
 * that answer verbatim — a program's segments go into the middle group and nowhere else, because
 * that is the only place this component reads them from (#7500 ruling 5). An empty middle is an
 * empty group, never an error: `middleEmpty` names a step of a walk that did not resolve, and the
 * bar carries no room for that sentence.
 *
 * The shell's own prefix and pending sequence ride the right group beside the kernel facts, and the
 * armed prefix is announced as text in a polite live region as well as shown, because a state
 * carried only by a highlight is a state a screen-reader user never learns (Pillar 4, "never signal
 * state by colour alone").
 *
 * A `section` rather than a `footer`: an accessible name needs a role that takes one, and a `footer`
 * nested inside the desk is generic. `region` also makes the line a landmark of its own; each group
 * inside it is a `group`, which is the role that takes the name each one owes.
 */

import {Kbd} from "@kampus/design";
import type {ReactElement} from "react";
import type {StatusBar, StatusSegment} from "../desk/index.ts";
import "./desk.css";
import type {StatusFrame} from "./frame.ts";

export interface StatusLineProps {
	readonly frame: StatusFrame;
	readonly bar: StatusBar;
	readonly prefixKey: string;
}

const Segments = ({segments}: {readonly segments: ReadonlyArray<StatusSegment>}): ReactElement => (
	<>
		{segments.map((segment) => (
			// `tone` is a name, never a colour: the segment says "attention" and this surface decides
			// what that looks like (`../desk/renderer.ts`).
			<span key={segment.id} className="tuval-status-segment" data-tone={segment.tone ?? "normal"}>
				{segment.text}
			</span>
		))}
	</>
);

export function StatusLine({frame, bar, prefixKey}: StatusLineProps): ReactElement {
	return (
		<section className="tuval-status" aria-label="Shell status">
			{/* biome-ignore lint/a11y/useSemanticElements: the rule's `fieldset` groups form controls;
			    these three group read-only status text, and `group` is the only role that names one */}
			<div className="tuval-status-group" role="group" aria-label="Workspace">
				<Segments segments={bar.left} />
				<span>
					({frame.position.at}/{frame.position.of})
				</span>
				<span>
					{frame.windowCount} window{frame.windowCount === 1 ? "" : "s"}
					{frame.zoomed ? " · zoomed" : ""}
				</span>
			</div>
			{/* biome-ignore lint/a11y/useSemanticElements: see the group above */}
			<div className="tuval-status-group tuval-status-middle" role="group" aria-label="Program">
				<Segments segments={bar.middle} />
			</div>
			{/* biome-ignore lint/a11y/useSemanticElements: see the group above */}
			<div className="tuval-status-group" role="group" aria-label="Shell">
				<span>
					prefix <Kbd>{prefixKey}</Kbd> <strong>{frame.prefixArmed ? "armed" : "idle"}</strong>
				</span>
				<span>
					pending <strong>{frame.pending.length === 0 ? "—" : frame.pending.join("")}</strong>
				</span>
				<Segments segments={bar.right} />
			</div>
			<span className="tuval-refusal" role="status" aria-live="polite">
				{frame.announcement}
			</span>
		</section>
	);
}
