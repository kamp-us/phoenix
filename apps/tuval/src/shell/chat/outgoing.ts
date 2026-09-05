/**
 * The text one window has already handed to its process, kept until the session says what became
 * of it.
 *
 * The composer clears the moment the operator sends — a composer that stayed full until a backend
 * answered would make every turn feel stuck — so the text moves here instead of being dropped, under
 * the same idempotency key the send carries. `../../ai-agent/core/sends.ts` is the other half: it
 * names the outcome, and this decides what the window does with it. A send the layer took drops its
 * copy; a refused or unconfirmed one becomes a recovery the operator can take, or leave.
 *
 * Everything is per window, because the view slot is (`./view.ts`). Two windows racing to send hold
 * their own keys and read only their own outcomes, so neither can restore the other's text or clear
 * its draft.
 */

import type {SendOutcome} from "../../ai-agent/core/index.ts";

/**
 * A **type alias and not an interface**, for the reason `ChatView` is one (`./view.ts`): this rides
 * inside the slot, the slot is `Schema.Json`, and TypeScript gives an object type alias the implicit
 * index signature that assignment needs while an interface gets none.
 */
export type OutgoingSend = {
	readonly key: string;
	readonly text: string;
};

/** A held send the session has settled against, and how it settled. */
export interface UnsentMessage {
	readonly key: string;
	readonly text: string;
	readonly reason: "refused" | "uncertain";
}

/**
 * How many sends one window holds. A held copy leaves as soon as its outcome is known, so more than
 * one at a time means the operator sent again over an unresolved recovery — which is theirs to
 * make, up to the point where the bar above the composer stops being a bar.
 */
export const heldLimit = 5;

export const holdSend = (
	held: ReadonlyArray<OutgoingSend>,
	send: OutgoingSend,
): ReadonlyArray<OutgoingSend> =>
	[...held.filter((other) => other.key !== send.key), send].slice(-heldLimit);

export const dropSend = (
	held: ReadonlyArray<OutgoingSend>,
	key: string,
): ReadonlyArray<OutgoingSend> => held.filter((other) => other.key !== key);

/**
 * Which held sends the window is still holding for a reason, and which it may let go of.
 *
 * A key the session has said nothing about yet is neither: the send is in flight, or its Msg has
 * not come back round, and both are "wait". Only an `accepted` outcome releases a copy, so no path
 * through here drops text on silence.
 */
export interface HeldSends {
	/** Settled against the operator: a bar, a Restore and a Discard. */
	readonly unsent: ReadonlyArray<UnsentMessage>;
	/** The layer took these; their copies are the window's to drop. */
	readonly landed: ReadonlyArray<string>;
}

export const readHeld = (
	held: ReadonlyArray<OutgoingSend>,
	sends: ReadonlyArray<SendOutcome>,
): HeldSends => {
	const unsent: Array<UnsentMessage> = [];
	const landed: Array<string> = [];
	for (const send of held) {
		const outcome = sends.find((candidate) => candidate.key === send.key);
		if (outcome === undefined || outcome.state === "pending") continue;
		if (outcome.state === "accepted") landed.push(send.key);
		else unsent.push({key: send.key, text: send.text, reason: outcome.state});
	}
	return {unsent, landed};
};

/**
 * What the composer holds after a deliberate recovery.
 *
 * Nothing typed since the send is lost: the recovered text goes above the current draft rather than
 * over it, so recovery is additive whether or not the operator has started something new. A blank
 * line between them is what keeps two thoughts from reading as one paragraph.
 */
export const recoverInto = (draft: string, saved: string): string =>
	draft === "" ? saved : `${saved}\n\n${draft}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** A slot's held sends, read back total: anything that is not a `{key, text}` pair is not one. */
export const asOutgoing = (value: unknown): ReadonlyArray<OutgoingSend> =>
	Array.isArray(value)
		? value
				.filter(
					(entry): entry is OutgoingSend =>
						isRecord(entry) && typeof entry.key === "string" && typeof entry.text === "string",
				)
				.map((entry) => ({key: entry.key, text: entry.text}))
				.slice(-heldLimit)
		: [];
