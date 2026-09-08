/**
 * Where the session compacted its context — a divider across the transcript, with the summary a
 * disclosure away.
 *
 * The operator's question at this point is "why are the earlier turns gone", and the answer is
 * positional: everything above the rule was summarised away. So the boundary is still a real `hr`
 * with a short label beside it, and the label is still the micro uppercase line the divider needs.
 *
 * What the label is *not* is the payload. Pi's compaction item carries the whole summary the model
 * wrote — a markdown document opening `## Goal …` (`../../pi/wire/compaction.ts`, #8588) — and
 * uppercasing that onto one nowrap line scrolled the transcript sideways for the rest of the
 * session (#8608). So the line beside the rule is a cut preview, and the document itself renders
 * opened as ordinary markdown, wrapping like any other row.
 *
 * The disclosure is `Collapsible` from `@kampus/design`, the same primitive `ThinkingRow` and
 * `ToolRow` use, so `aria-expanded` and `aria-controls` are the primitive's and the accessible
 * name is the preview line. Open/closed is controlled off the window's own `view.expanded` set,
 * which is what makes two windows over one process disclose independently.
 */

import {Collapsible, Markdown} from "@kampus/design";
import type {ReactElement} from "react";

/** Longest preview the collapsed divider shows, in characters. */
const PREVIEW_CHARS = 72;

/**
 * The divider's line, which is also the disclosure's accessible name. The first line that carries
 * anything, with a markdown heading's own `#` run dropped — the marker is the document's syntax,
 * not something the operator asked to read — cut to `PREVIEW_CHARS`; a fixed word when the payload
 * is whitespace, so the control is never nameless.
 */
export const compactionLine = (text: string): string => {
	const first =
		text
			.split("\n")
			.map((line) => line.trim().replace(/^#{1,6}\s+/, ""))
			.find((line) => line.length > 0) ?? "";
	if (first.length === 0) return "Context compacted";
	return first.length <= PREVIEW_CHARS ? first : `${first.slice(0, PREVIEW_CHARS).trimEnd()}…`;
};

export function CompactionMarker({
	text,
	expanded,
	onToggle,
}: {
	readonly text: string;
	readonly expanded: boolean;
	readonly onToggle: (open: boolean) => void;
}): ReactElement {
	return (
		<div className="tuval-chat-compaction">
			<Collapsible
				className="tuval-chat-compaction-disclosure"
				open={expanded}
				onOpenChange={onToggle}
				trigger={<span className="tuval-chat-compaction-label">{compactionLine(text)}</span>}
			>
				<Markdown
					className="tuval-chat-markdown tuval-chat-compaction-summary"
					headingBase={3}
					breaks
				>
					{text}
				</Markdown>
			</Collapsible>
			<hr className="tuval-chat-compaction-rule" />
		</div>
	);
}
