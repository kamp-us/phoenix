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
 * renders it, so this module knows nothing about how a page gets one — the page binds a source that
 * calls `session.list` over its socket (`../../page/renderers.tsx`, #8161). It is handed this
 * window's id, because the call carries the window it came from and the kernel resolves the rest.
 * At its default it hands `null`, "nothing has been read yet", which is what a fixture or a surface
 * with no socket behind it renders.
 *
 * **Four states, none of them a blank window.** No answer yet, a refused call, an empty store, and a
 * store whose backends could not be read are four different sentences — the last two are the pair
 * that matters, because a failed read rendered as an empty list tells an operator they have no
 * sessions.
 */

import {CommandPalette, type CommandPaletteItem} from "@kampus/design";
import type {ReactElement, KeyboardEvent as ReactKeyboardEvent, ReactNode} from "react";
import {useCallback, useMemo, useState} from "react";
import type {SessionListAnswer} from "../../page/session-list.ts";
import {failureLine} from "../../palette/call.ts";
import type {WindowId} from "../../protocol/ids.ts";
import type {SessionRow, UnreadableBackend} from "../../protocol/session-list.ts";
import type {AnyWindowRenderer, WindowHost} from "../../shell/window/index.ts";
import {windowRenderer} from "../../shell/window/index.ts";
import {
	listView,
	type OpenPhase,
	type OpenTarget,
	openRead,
	type SendPlan,
	type SessionListView,
	send,
	sessionView,
	type TranscriptRead,
} from "./opening.ts";
import {matchesQuery, rowValue, sessionItems} from "./rows.ts";
import {SessionTranscriptView, type TranscriptAnswer} from "./SessionTranscript.tsx";
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
	/**
	 * A row was picked, and where it should land: `inline` for plain activation, `new-window` for
	 * Cmd+Enter. Reported for both targets, because the inline open is this component's own act and
	 * the other window is the page's — but neither is a spawn, so this fires on a read either way
	 * (epic #8070, ruling 5).
	 */
	readonly onActivate?: (session: SessionRow, target: OpenTarget) => void;
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
			onActivate?.(session, "inline");
		},
		[byValue, onActivate],
	);

	// Cmd+Enter is the other window (ruling 5), and it must never also be the plain activation: the
	// palette's own Enter would select the row and replace this window, so the event is taken here
	// and `preventDefault` is what stops it reaching that path (`@kampus/design`'s `CommandPalette`
	// returns early on a defaulted-prevented event).
	const keyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLInputElement>, active: CommandPaletteItem | undefined) => {
			if (event.key !== "Enter" || !event.metaKey || active === undefined) return;
			const session = byValue.get(active.value);
			if (session === undefined) return;
			event.preventDefault();
			setChosen(active.label);
			onActivate?.(session, "new-window");
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
				onKeyDown={keyDown}
				shortcut={false}
				announcement={chosen === null ? null : `Chose ${chosen}.`}
				{...(error === undefined ? {} : {error})}
			/>
			{unreadable.length === 0 ? null : <UnreadableBackends backends={unreadable} />}
		</div>
	);
}

/**
 * How the renderer gets the answer to render. The page owns it; the default hands nothing. It is a
 * hook the window calls on every render, so a source that reads state re-renders the window when the
 * answer lands. The window id rides along because a call names the window it came from.
 */
export type SessionListSource = (window: WindowId) => SessionListAnswer | null;

const nothingRead: SessionListSource = () => null;

/** How the renderer gets one session's transcript. The default reads none, so a window says so. */
export type TranscriptSource = (read: TranscriptRead) => TranscriptAnswer | null;

const nothingPaged: TranscriptSource = () => null;

export interface SessionListWindowOptions {
	readonly useAnswer?: SessionListSource;
	readonly useTranscript?: TranscriptSource;
	/** Reported for both targets; the inline open is this window's own act either way. */
	readonly onActivate?: (session: SessionRow, target: OpenTarget) => void;
	/**
	 * Open this session in a window other than this one, read-only exactly as the inline open is.
	 * The page owns it, because splitting the desk is the shell's and not this renderer's; absent,
	 * Cmd+Enter still refuses to replace this window rather than falling back to the inline open.
	 */
	readonly onOpenInNewWindow?: (session: SessionRow) => void;
	/**
	 * The operator sent. `plan.spawn` is the process this send has to create, and it is non-null on
	 * exactly one send per opened session — the first (`./opening.ts`'s `send`). A caller spawns
	 * when it is set and sends into the process it already has when it is not.
	 */
	readonly onSend?: (session: SessionRow, text: string, plan: SendPlan) => void;
}

/**
 * The window's own view: the list, or one session's transcript in place of it (ruling 5, "the
 * default should be inline though").
 *
 * The switch is state here rather than a prop, because it is this window's act: nothing outside has
 * to be told a row was picked for the list to be replaced, and a window that had to wait for the
 * kernel to tell it what it is showing would show the list for a round trip after the pick.
 * Cmd+Enter takes the other door — `onOpenInNewWindow` — and never touches this state, so the two
 * targets cannot collapse into one.
 */
function SessionListHost({
	window,
	useAnswer,
	useTranscript,
	onActivate,
	onOpenInNewWindow,
	onSend,
}: SessionListWindowOptions & {readonly window: WindowId}): ReactElement {
	const answer = (useAnswer ?? nothingRead)(window);
	const [view, setView] = useState<SessionListView>(listView);
	const [phase, setPhase] = useState<OpenPhase>("reading");

	const activate = useCallback(
		(session: SessionRow, target: OpenTarget) => {
			onActivate?.(session, target);
			if (target === "new-window") {
				onOpenInNewWindow?.(session);
				return;
			}
			setPhase("reading");
			setView(sessionView(session));
		},
		[onActivate, onOpenInNewWindow],
	);

	const back = useCallback(() => setView(listView), []);

	if (view.kind === "list") {
		return <SessionList answer={answer} onActivate={activate} />;
	}

	const request = openRead(view.session);
	const page = request._tag === "Read" ? (useTranscript ?? nothingPaged)(request.read) : null;
	return (
		<SessionTranscriptView
			session={view.session}
			answer={page}
			unopenable={request._tag === "OpenRefused"}
			onBack={back}
			onSend={(text) => {
				// The phase is what makes the transition happen once: the first send hands back a spawn
				// and moves to `live`, and every send after it hands back none.
				const plan = send(phase, view.session);
				setPhase(plan.phase);
				onSend?.(view.session, text, plan);
			}}
		/>
	);
}

/** The renderer at whatever source a caller has. The host is read for its window id and nothing else. */
export const sessionListWindow = (options: SessionListWindowOptions = {}): AnyWindowRenderer =>
	windowRenderer(
		"host-native",
		(host: WindowHost): ReactNode => <SessionListHost {...options} window={host.windowId} />,
	);

/** The renderer `SESSION_LIST_WINDOW_REF` names, at its defaults: what a page's table binds. */
export const SessionListWindow: AnyWindowRenderer = sessionListWindow();
