/**
 * What one chat window keeps in its own `view` slot, and how a slot of unknown shape is read back.
 *
 * Seven facts live here and nothing else: whether the transcript is following its newest turn, where
 * it was scrolled to otherwise, what was typed and not yet sent, how far back into history this
 * window has walked, which rows it has disclosed, which group heads have their folded rows showing,
 * and which transcript the window's one view slot is showing. Two windows over one process share
 * the transcript and own one of these each (#7484 R1.1), so everything here is per-window —
 * including `expanded`, which is why the same tool call can be open in one window and closed in the
 * other, and including `viewing`, which is what lets two windows sit on two different subagents.
 *
 * Two of those seven do not survive a mount. The pages a window walked back to are the window's own
 * React state, rebuilt empty every time it is mounted, so `cursor` and `atOldest` are read back as a
 * fresh window's however the slot wrote them. Restored, they described rows the window did not hold,
 * and `atOldest` is precisely what suppresses the affordance that could fetch them — so a window
 * that had paged to the beginning of history came back holding the live tail and no route to the
 * rest of the transcript (#9047).
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

/**
 * The subagent this window's one view slot is showing, and where main was left when it swapped.
 *
 * One field rather than two, because "which transcript is showing" and "where main was parked" are
 * the same fact: a window on main has no parked position to restore, and a window on a subagent
 * always has one. Split, a slot could say it is on main while parking an offset — a state the back
 * action could not read.
 */
export type ChatSubagentView = {
	/** The spawning call's item id — the key of the slot whose transcript is showing. */
	readonly id: string;
	/** Where main was resting when this window swapped away from it. The back action restores it. */
	readonly from: {readonly pinned: boolean; readonly scroll: number};
};

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
	/**
	 * The oldest item id this window has walked back to, or `null` while it holds only the live tail.
	 * Per-mount: the read-back answers `null` whatever the slot holds, because the pages it names are
	 * not checkpointed beside it.
	 */
	readonly cursor: string | null;
	/**
	 * The backend answered that there is nothing older; the transcript is at the beginning of history.
	 * Per-mount for the same reason as `cursor`, and the one that made restoring it a bug.
	 */
	readonly atOldest: boolean;
	/** The ids of the rows this window has disclosed — a tool call's detail, a thinking row's text. */
	readonly expanded: ReadonlyArray<string>;
	/** The ids of the group heads whose folded rows this window is showing. Absent means folded. */
	readonly unfolded: ReadonlyArray<string>;
	/**
	 * Which transcript the one view slot shows: `null` is the agent's own, a record is the subagent
	 * swapped in over it (founder ruling Q7 on #8384 — one window, one slot, swapped in place).
	 * `pinned` and `scroll` above always describe the *current* view, which is why the place main was
	 * left is parked in here rather than overwritten.
	 */
	readonly viewing: ChatSubagentView | null;
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
	viewing: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Read the view slot's own field back. Total like everything beside it: a slot from a build that had
 * no such field, and one whose record is any other shape, are both a window on main.
 */
const asSubagentView = (value: unknown): ChatSubagentView | null => {
	if (!isRecord(value)) return null;
	if (typeof value.id !== "string" || value.id.length === 0) return null;
	const from = isRecord(value.from) ? value.from : {};
	return {
		id: value.id,
		from: {
			pinned: from.pinned !== false,
			scroll: typeof from.scroll === "number" && Number.isFinite(from.scroll) ? from.scroll : 0,
		},
	};
};

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
		// Not read off the slot at all: the pages these two describe are the window's own React state,
		// rebuilt empty on every mount, and a restored walk over no rows suppresses the affordance
		// that could refill it (#9047).
		cursor: initialChatView.cursor,
		atOldest: initialChatView.atOldest,
		expanded: Array.isArray(value.expanded)
			? value.expanded.filter((id): id is string => typeof id === "string")
			: [],
		unfolded: Array.isArray(value.unfolded)
			? value.unfolded.filter((id): id is string => typeof id === "string")
			: [],
		viewing: asSubagentView(value.viewing),
	};
};

/**
 * Swap the slot onto a subagent, parking where main was left. Already there is a no-op, and a swap
 * straight from one subagent to another keeps the *original* park: main was left once.
 *
 * The swapped-in view starts on its own newest row rather than on main's offset, which is an offset
 * into a transcript this one is not.
 */
export const viewSubagent = (view: ChatView, id: string): ChatView => {
	if (view.viewing?.id === id) return view;
	const from = view.viewing?.from ?? {pinned: view.pinned, scroll: view.scroll};
	return {...view, pinned: true, scroll: 0, viewing: {id, from}};
};

/** Swap back to main, onto the row and offset it was left on. Already there is a no-op. */
export const viewMain = (view: ChatView): ChatView => {
	if (view.viewing === null) return view;
	const {from} = view.viewing;
	return {...view, pinned: from.pinned, scroll: from.scroll, viewing: null};
};
