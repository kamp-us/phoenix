/**
 * What the `ai-agent-sessions` row renders: every registered backend's sessions as one newest-first
 * list behind a type-to-filter box (epic #8070, rulings 3, 6 and 7).
 *
 * **It is the shared palette, inline.** The field, the listbox, `aria-activedescendant`, the
 * movement keys and the scroll-into-view are `@kampus/design`'s `CommandPalette`
 * (`.patterns/command-palette.md`, ADR 0186) and none of them is re-derived here — #7882 deleted the
 * last second copy of that pattern. The palette was modal-only, so this slice added its `inline`
 * presentation rather than forking it: a window is not an overlay, and a modal inside one traps the
 * whole desk behind a list.
 *
 * **The list is handed in.** `useAnswer` is the seam: the renderer asks for the current answer and
 * renders it, so this module knows nothing about how a page gets one. At its default it hands
 * `null` — "nothing has been read yet" — because the page→kernel spell channel the `session.list`
 * spell (`../session-list.ts`, #8101) answers on does not exist yet: `PageAttachment`
 * (`../../shell/transport/client.ts`) carries no way to send a `SpellCall`, and the one caller that
 * builds them today is answered by the page itself (`../../shell/ui/PaletteHost.tsx`). That gap is
 * #8161.
 *
 * **Four states, none of them a blank window.** No answer yet, a refused call, an empty store, and a
 * store whose backends could not be read are four different sentences — the last two are the pair
 * that matters, because a failed read rendered as an empty list tells an operator they have no
 * sessions.
 */

import {CommandPalette, type CommandPaletteItem} from "@kampus/design";
import type {ReactElement, ReactNode} from "react";
import {useCallback, useMemo, useState} from "react";
import type {SessionListAnswer} from "../../page/session-list.ts";
import {failureLine} from "../../palette/call.ts";
import type {SessionRow, UnreadableBackend} from "../../protocol/session-list.ts";
import type {AnyWindowRenderer} from "../../shell/window/index.ts";
import {windowRenderer} from "../../shell/window/index.ts";
import {matchesQuery, rowValue, sessionItems} from "./rows.ts";
import "./session-list-window.css";

const TITLE = "AI agent sessions";

/** Every sentence the surface can say, in one place, so no two of them can drift into each other. */
const COPY = {
	placeholder: "Filter by prompt, folder or branch",
	reading: "Reading every registered backend's sessions…",
	emptyStore: "No sessions on this machine yet.",
	allRefused: "No sessions: every backend that could have answered refused the read.",
	noMatch: "No session matches this filter.",
	refused: "The kernel refused the session list.",
} as const;

/** One backend that could not answer, named with the store's own words rather than a paraphrase. */
const UnreadableBackends = ({
	backends,
}: {
	readonly backends: ReadonlyArray<UnreadableBackend>;
}): ReactElement => (
	<div className="tuval-session-list-unreadable" role="alert">
		<p>
			{backends.length === 1
				? "One backend could not be read, so its sessions are missing from this list:"
				: `${backends.length} backends could not be read, so their sessions are missing from this list:`}
		</p>
		<ul>
			{backends.map((backend) => (
				<li key={backend.programId}>
					<strong>{backend.programId}</strong> — {backend.detail}
				</li>
			))}
		</ul>
	</div>
);

export interface SessionListProps {
	/** The answer to render. `null` is "nothing has been read yet", never "there are no sessions". */
	readonly answer: SessionListAnswer | null;
	/** What a picked row does. This slice only reports the choice; opening it is #8104's. */
	readonly onActivate?: (session: SessionRow) => void;
	/** The clock the "3 hours ago" column is measured against. A parameter so a test can pin it. */
	readonly now?: number;
}

/**
 * The session list over one answer. A component rather than a hook plus markup, because everything
 * it owns — the filter term, the active row, the announcement — is the palette's or this render's,
 * and none of it outlives the window.
 */
export function SessionList({answer, onActivate, now}: SessionListProps): ReactElement {
	const [chosen, setChosen] = useState<string | null>(null);
	const clock = now ?? Date.now();

	const sessions = answer?._tag === "Listed" ? answer.sessions : [];
	const unreadable = answer?._tag === "Listed" ? answer.unreadable : [];

	const byValue = useMemo(
		() => new Map(sessions.map((session) => [rowValue(session), session])),
		[sessions],
	);
	const items = useMemo(() => sessionItems(sessions, clock), [sessions, clock]);

	// The palette's own filter reads an item's copy; this one reads the session behind it, so the
	// backend tag and the timestamp in the description line stay outside the match (ruling 7).
	const filter = useCallback(
		(item: CommandPaletteItem, query: string): boolean => {
			const session = byValue.get(item.value);
			return session !== undefined && matchesQuery(session, query);
		},
		[byValue],
	);

	const select = useCallback(
		(item: CommandPaletteItem) => {
			const session = byValue.get(item.value);
			if (session === undefined) return;
			setChosen(item.label);
			onActivate?.(session);
		},
		[byValue, onActivate],
	);

	// Only reached once an answer has landed: before that the palette is `loading` and shows
	// `loadingLabel` instead, which is the "nothing has been read yet" state.
	const emptyLabel =
		answer?._tag === "Refused"
			? COPY.refused
			: sessions.length === 0
				? unreadable.length === 0
					? COPY.emptyStore
					: COPY.allRefused
				: COPY.noMatch;

	const error: ReactNode =
		answer !== null && answer._tag === "Refused" ? failureLine(answer.failure) : undefined;

	return (
		<div className="tuval-session-list">
			<CommandPalette
				presentation="inline"
				items={items}
				title={TITLE}
				placeholder={COPY.placeholder}
				emptyLabel={emptyLabel}
				loading={answer === null}
				loadingLabel={COPY.reading}
				filter={filter}
				onSelect={select}
				shortcut={false}
				announcement={chosen === null ? null : `Chose ${chosen}.`}
				{...(error === undefined ? {} : {error})}
			/>
			{unreadable.length === 0 ? null : <UnreadableBackends backends={unreadable} />}
		</div>
	);
}

/** How the renderer gets the answer to render. The page owns it; the default hands nothing. */
export type SessionListSource = () => SessionListAnswer | null;

const nothingRead: SessionListSource = () => null;

export interface SessionListWindowOptions {
	readonly useAnswer?: SessionListSource;
	readonly onActivate?: (session: SessionRow) => void;
}

function SessionListHost({useAnswer, onActivate}: SessionListWindowOptions): ReactElement {
	const answer = (useAnswer ?? nothingRead)();
	return <SessionList answer={answer} {...(onActivate === undefined ? {} : {onActivate})} />;
}

/** The renderer at whatever source a caller has. The window host is unread: this surface is a list. */
export const sessionListWindow = (options: SessionListWindowOptions = {}): AnyWindowRenderer =>
	windowRenderer("host-native", (): ReactNode => <SessionListHost {...options} />);

/** The renderer `SESSION_LIST_WINDOW_REF` names, at its defaults: what a page's table binds. */
export const SessionListWindow: AnyWindowRenderer = sessionListWindow();
