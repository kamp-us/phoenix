/**
 * The sends this window is holding because nobody could say they landed, each with the two acts the
 * operator has: take the text back, or let it go.
 *
 * Neither act resends. A refused prompt is not running anywhere and an unconfirmed one might be, so
 * a resend on the operator's behalf is either a turn they did not ask for or a duplicate of one they
 * did — which is why the only thing Restore does is put the words back in the composer (#8005).
 *
 * The list is the accessible unit: one `li` per held send, its text a real paragraph, and each
 * button described by that paragraph. Two "Restore" buttons in a row are ambiguous read as names
 * alone, and `aria-describedby` is what tells them apart without retyping the message into a label
 * (`.patterns/manti-accessibility.md`).
 */

import {Button} from "@kampus/design";
import type {ReactElement} from "react";
import type {UnsentMessage} from "./outgoing.ts";

/** One line per arm, because "we could not send this" and "we do not know" are different asks. */
const lines: Readonly<Record<UnsentMessage["reason"], string>> = {
	refused: "This message was not sent.",
	uncertain: "This message may not have been sent.",
};

const rowId = (windowId: string, key: string): string => `tuval-unsent-${windowId}-${key}`;

/**
 * A window holding nothing renders nothing at all. An empty-state treatment here would give the
 * ordinary case — every send landed — a permanent strip of chrome saying so (ADR 0162, Pillar 3).
 */
export function UnsentMessages({
	windowId,
	unsent,
	onRestore,
	onDiscard,
}: {
	readonly windowId: string;
	readonly unsent: ReadonlyArray<UnsentMessage>;
	readonly onRestore: (key: string) => void;
	readonly onDiscard: (key: string) => void;
}): ReactElement | null {
	if (unsent.length === 0) return null;
	return (
		<div className="tuval-chat-unsent" role="status">
			<ul className="tuval-chat-unsent-list" aria-label="Unsent messages">
				{unsent.map((message) => {
					const id = rowId(windowId, message.key);
					return (
						<li key={message.key} className="tuval-chat-unsent-item">
							<p className="tuval-chat-unsent-reason">{lines[message.reason]}</p>
							<p id={id} className="tuval-chat-unsent-text">
								{message.text}
							</p>
							<div className="tuval-chat-unsent-actions">
								<Button
									type="button"
									variant="secondary"
									size="sm"
									aria-describedby={id}
									onClick={() => onRestore(message.key)}
								>
									Restore
								</Button>
								<Button
									type="button"
									variant="tertiary"
									size="sm"
									aria-describedby={id}
									onClick={() => onDiscard(message.key)}
								>
									Discard
								</Button>
							</div>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
