/**
 * The messages the operator wrote while the turn was running, waiting to be sent (#8159).
 *
 * It renders the session's own queue (`ai-agent/core/queue.ts`) rather than anything this window
 * remembers, so both windows over one process show the same waiting text and a window opened after
 * the send shows it too. Nothing here is a transcript row: none of it has reached the agent, and a
 * tail that showed it would be claiming a turn the backend has never heard of.
 *
 * It sits directly above the composer, where `UnsentMessages` sits, because both answer the same
 * question — where did the words I just typed go — and an operator who has to look in two places
 * for that answer is the state this surface exists to end.
 */

import type {ReactElement} from "react";

export interface QueuedMessage {
	readonly key: string;
	readonly text: string;
}

/** A window with an empty queue renders nothing: the ordinary case earns no permanent chrome. */
export function QueuedMessages({
	queued,
}: {
	readonly queued: ReadonlyArray<QueuedMessage>;
}): ReactElement | null {
	if (queued.length === 0) return null;
	return (
		<div className="tuval-chat-queued">
			{/* The live region is this line alone. The messages themselves are the operator's own
			    words read back, and announcing each one re-reads what they just typed. */}
			<p className="tuval-chat-queued-lead" role="status">
				{queued.length === 1
					? "1 message is waiting for the turn to end."
					: `${queued.length} messages are waiting for the turn to end.`}
			</p>
			<ul className="tuval-chat-queued-list" aria-label="Queued messages">
				{queued.map((message) => (
					<li key={message.key} className="tuval-chat-queued-item">
						{message.text}
					</li>
				))}
			</ul>
		</div>
	);
}
