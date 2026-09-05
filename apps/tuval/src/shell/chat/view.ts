/**
 * What one chat window keeps in its own `view` slot, and how a slot of unknown shape is read back.
 *
 * Four facts live here and nothing else: where the transcript was scrolled to, what was typed and
 * not yet sent, how far back into history this window has walked, and which tool rows it has opened.
 * Two windows over one process share the transcript and own one of these each (#7484 R1.1), so
 * everything here is per-window — including `expanded`, which is why the same tool call can be open
 * in one window and closed in the other.
 *
 * `ChatView` is a **type alias and not an interface** on purpose. The slot is `Schema.Json`
 * (`../window/host.ts`), and TypeScript gives an object *type alias* the implicit index signature
 * that assignment needs while an interface — which a later declaration may widen — gets none. An
 * interface here type-checks nowhere it is used as the slot; `boundary.unit.test.ts` pins that.
 */

import type {ViewState} from "../window/index.ts";

export type ChatView = {
	/** Pixels from the top of the transcript. Restored on the next mount over this window. */
	readonly scroll: number;
	/** The composer's text, so a window switched away from and back to still holds it. */
	readonly draft: string;
	/** The oldest item id this window has walked back to, or `null` while it holds only the live tail. */
	readonly cursor: string | null;
	/** The backend answered that there is nothing older; the transcript is at the beginning of history. */
	readonly atOldest: boolean;
	/** The ids of the tool rows this window has expanded. A row absent from it is collapsed. */
	readonly expanded: ReadonlyArray<string>;
};

export const initialChatView: ChatView = {
	scroll: 0,
	draft: "",
	cursor: null,
	atOldest: false,
	expanded: [],
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
		scroll: typeof value.scroll === "number" && Number.isFinite(value.scroll) ? value.scroll : 0,
		draft: typeof value.draft === "string" ? value.draft : "",
		cursor: typeof value.cursor === "string" ? value.cursor : null,
		atOldest: value.atOldest === true,
		expanded: Array.isArray(value.expanded)
			? value.expanded.filter((id): id is string => typeof id === "string")
			: [],
	};
};
