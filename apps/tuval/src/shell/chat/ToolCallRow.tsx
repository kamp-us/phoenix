/**
 * One call inside an opened run: its line, and — when it has anything more to say — its detail a
 * disclosure away.
 *
 * The disclosure is `Collapsible`, whose trigger is a real `<button>` (`@manti-ui/react@0.9.0`,
 * `dist/index.js`), so Enter and Space are the platform's activation behaviour rather than a
 * hand-written `onKeyDown` over `role="button"` — which is what T3 needs and this does not
 * (`MessagesTimeline.tsx:3352-3366`).
 *
 * A call whose detail would only repeat the line is not a disclosure at all: no button, no
 * `aria-expanded`, nothing in the tab order. The chevron's place is held by an `aria-hidden` span
 * so the labels of the rows around it still line up.
 */

import {Collapsible} from "@kampus/design";
import type {ReactElement} from "react";
import type {ToolCall} from "./rows.ts";
import {ToolCallDetail} from "./ToolCallDetail.tsx";
import {callDisclosure, callLabel, canExpandCall} from "./tool-detail.ts";

export function ToolCallRow({
	item,
	expanded,
	onToggle,
}: {
	readonly item: ToolCall;
	readonly expanded: boolean;
	readonly onToggle: (open: boolean) => void;
}): ReactElement {
	const label = callLabel(item);
	const disclosure = callDisclosure(item, label);
	const line = (
		<span className="tuval-chat-tool-head">
			<span className="tuval-chat-tool-call-label">{label}</span>
			<span className="tuval-chat-tool-status" data-status={item.status}>
				{item.status}
			</span>
		</span>
	);
	if (!canExpandCall(disclosure)) {
		return (
			<span className="tuval-chat-tool-call tuval-chat-tool-call-flat">
				{line}
				<span className="tuval-chat-tool-call-blank" aria-hidden="true" />
			</span>
		);
	}
	return (
		<Collapsible
			className="tuval-chat-tool tuval-chat-tool-call"
			open={expanded}
			onOpenChange={onToggle}
			trigger={line}
		>
			<ToolCallDetail disclosure={disclosure} />
		</Collapsible>
	);
}
