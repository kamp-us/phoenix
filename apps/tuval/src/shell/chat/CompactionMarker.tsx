/**
 * Where the session compacted its context — a divider across the transcript, not a line of prose.
 *
 * The operator's question at this point is "why are the earlier turns gone", and the answer is
 * positional: everything above the rule was summarised away. A paragraph would sit in the reading
 * order as one more thing the session said, and be scrolled past like one.
 *
 * So the boundary is a real `hr` and the line beside it is ordinary text: assistive tech reads a
 * separator and then what it separates, with no `aria-label` restating a string that is already
 * there. The rule is drawn by `chat.css`; nothing here is generated content.
 */

import type {ReactElement} from "react";

export function CompactionMarker({text}: {readonly text: string}): ReactElement {
	return (
		<div className="tuval-chat-compaction">
			<span className="tuval-chat-compaction-label">{text}</span>
			<hr className="tuval-chat-compaction-rule" />
		</div>
	);
}
