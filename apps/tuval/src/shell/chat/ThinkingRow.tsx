/**
 * One turn's reasoning, collapsed to a line and expandable to the whole of it.
 *
 * The trigger carries a *preview* rather than the text, and that is the whole design: reasoning
 * arrives as paragraphs, and rendering it unfolded floods the window the way the subagent rows did
 * before #8027 folded them. So the row's job collapsed is to say the agent is thinking and roughly
 * about what; the text itself is one act away.
 *
 * The disclosure is `Collapsible` from `@kampus/design`, the same primitive `ToolRow` uses, so the
 * trigger's `aria-expanded` and `aria-controls` are the primitive's and the accessible name is the
 * preview line (`.patterns/manti-accessibility.md`). Open/closed is controlled off the window's own
 * `view.expanded` set, which is what makes two windows over one process disclose independently.
 */

import {Collapsible} from "@kampus/design";
import type {ReactElement} from "react";
import type {ThinkingItem} from "../../ai-agent/ports/index.ts";

/** Longest preview the collapsed row shows, in characters. */
const PREVIEW_CHARS = 96;

/**
 * The collapsed row's line, which is also the disclosure's accessible name. The first line that
 * carries anything, cut to `PREVIEW_CHARS`; a fixed word when the reasoning is whitespace, so the
 * control is never nameless.
 */
export const thinkingLine = (text: string): string => {
	const first =
		text
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "";
	if (first.length === 0) return "Reasoning";
	return first.length <= PREVIEW_CHARS ? first : `${first.slice(0, PREVIEW_CHARS).trimEnd()}…`;
};

export function ThinkingRow({
	item,
	expanded,
	onToggle,
}: {
	readonly item: ThinkingItem;
	readonly expanded: boolean;
	readonly onToggle: (open: boolean) => void;
}): ReactElement {
	return (
		<Collapsible
			className="tuval-chat-thinking"
			open={expanded}
			onOpenChange={onToggle}
			trigger={<span className="tuval-chat-thinking-line">{thinkingLine(item.text)}</span>}
		>
			<p className="tuval-chat-text tuval-chat-thinking-text">{item.text}</p>
		</Collapsible>
	);
}
