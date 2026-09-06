/**
 * What one chat window keeps in its own `view` slot, and how a slot of unknown shape is read back.
 *
 * Six facts live here and nothing else: whether the transcript is following its newest turn, where
 * it was scrolled to otherwise, what was typed and not yet sent, how far back into history this
 * window has walked, which rows it has disclosed, and which group heads have their folded rows
 * showing. Two windows over one process share the transcript and own one of these each (#7484
 * R1.1), so everything here is per-window — including `expanded`, which is why the same tool call
 * can be open in one window and closed in the other.
 *
 * `expanded` and `unfolded` are two facts, not one: opening a call's input panel and revealing the
 * subagent rows it heads are different asks, and one control doing both is what left the revealed
 * rows unannounced to assistive tech (#8027).
 *
 * `ChatView` is a **type alias and not an interface** on purpose. The slot is `Schema.Json`
 * (`../window/host.ts`), and TypeScript gives an object *type alias* the implicit index signature
 * that assignment needs while an interface — which a later declaration may widen — gets none. An
 * interface here type-checks nowhere it is used as the slot; `boundary.unit.test.ts` pins that.
 */

import type {ViewState} from "../window/index.ts";
import {asOutgoing, type OutgoingSend} from "./outgoing.ts";

export type ChatView = {
	/**
	 * The transcript is resting on its newest turn and follows the next one. A pinned window is
	 * restored onto the newest row rather than onto `scroll`, because the offset that was the bottom
	 * when it was written is somewhere in the middle of a transcript that has grown since.
	 */
	readonly pinned: boolean;
	/** Pixels from the top of the transcript. Restored on the next mount, unless `pinned`. */
	readonly scroll: number;
	/** The composer's text, so a window switched away from and back to still holds it. */
	readonly draft: string;
	/**
	 * The text of sends this window has dispatched and not yet heard the outcome of (`./outgoing.ts`).
	 * The draft clears at dispatch and the copy lives here, so a prompt the process or the backend
	 * refuses is still the operator's to take back (#8005).
	 */
	readonly outgoing: ReadonlyArray<OutgoingSend>;
	/** The oldest item id this window has walked back to, or `null` while it holds only the live tail. */
	readonly cursor: string | null;
	/** The backend answered that there is nothing older; the transcript is at the beginning of history. */
	readonly atOldest: boolean;
	/** The ids of the rows this window has disclosed — a tool call's detail, a thinking row's text. */
	readonly expanded: ReadonlyArray<string>;
	/** The ids of the group heads whose folded rows this window is showing. Absent means folded. */
	readonly unfolded: ReadonlyArray<string>;
};

export const initialChatView: ChatView = {
	pinned: true,
	scroll: 0,
	draft: "",
	outgoing: [],
	cursor: null,
	atOldest: false,
	expanded: [],
	unfolded: [],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Read a slot back. Total by construction: a window opened onto this program for the first time
 * holds `null`, and a slot written by another program holds something else entirely — neither is an
 * error the surface may throw on, because the contract's own fallbacks are values.
 */
export const asChatView = (value: ViewState | undefined): ChatView => {
	if (!isRecord(value)) return initialChatView;
	return {
		// A slot written before this window followed anything carries no pin, and a window is
		// pinned until its reader scrolls away — so absent reads as pinned, not as parked.
		pinned: value.pinned !== false,
		scroll: typeof value.scroll === "number" && Number.isFinite(value.scroll) ? value.scroll : 0,
		draft: typeof value.draft === "string" ? value.draft : "",
		outgoing: asOutgoing(value.outgoing),
		cursor: typeof value.cursor === "string" ? value.cursor : null,
		atOldest: value.atOldest === true,
		expanded: Array.isArray(value.expanded)
			? value.expanded.filter((id): id is string => typeof id === "string")
			: [],
		unfolded: Array.isArray(value.unfolded)
			? value.unfolded.filter((id): id is string => typeof id === "string")
			: [],
	};
};
