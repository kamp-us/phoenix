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
 * **The list is handed in.** `useAnswer` is the seam: the renderer asks where the read has got to
 * and renders that, so this module knows nothing about how a page gets an answer — the page binds a
 * source that calls `session.list` over its socket (`../../page/renderers.tsx`, #8161). It is handed
 * this window's id, because the call carries the window it came from and the kernel resolves the
 * rest. At its default it hands a read nobody sent, which is what a fixture or a surface with no
 * socket behind it renders. `useTranscript` is the same seam for the session a row opens onto, bound
 * to the `session.transcript` spell by the same table (#8238).
 *
 * **Five states, none of them a blank window.** Reading, a fired deadline, a refused call, an empty
 * store, and a store whose backends could not be read are five different sentences — the last two
 * are the pair that matters, because a failed read rendered as an empty list tells an operator they
 * have no sessions.
 *
 * **The waiting state is a state, not the absence of one** (#8280). The seam hands a `Reading` that
 * carries when the call left and the bound it runs against, this window ticks a clock against it,
 * and a deadline that passes with no reply ends the wait rather than spinning forever. The readout
 * measures *time*, never work: one reply answers the whole union, so no per-backend progress exists
 * to show and none is invented.
 */

import {Button, CommandPalette, type CommandPaletteItem} from "@kampus/design";
import type {ReactElement, KeyboardEvent as ReactKeyboardEvent, ReactNode} from "react";
import {useCallback, useEffect, useMemo, useState} from "react";
import type {ReadingSessions, SessionListStatus} from "../../page/session-list.ts";
import {atClock, elapsedMillis, reading} from "../../page/session-list.ts";
import type {TranscriptAnswer} from "../../page/session-transcript.ts";
import {failureLine} from "../../palette/call.ts";
import type {WindowId} from "../../protocol/ids.ts";
import type {SessionRow, UnreadableBackend} from "../../protocol/session-list.ts";
import type {AnyWindowRenderer, WindowHost} from "../../shell/window/index.ts";
import {windowRenderer} from "../../shell/window/index.ts";
import {
	listView,
	type OpenPhase,
	type OpenRequest,
	type OpenTarget,
	openRead,
	type SendPlan,
	type SessionListView,
	send,
	sessionView,
} from "./opening.ts";
import {matchesQuery, rowValue, sessionItems} from "./rows.ts";
import {SessionTranscriptView} from "./SessionTranscript.tsx";
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
	elapsed: "Time the read has been out, against its deadline",
	timedOut: "The read ran past its deadline before any backend answered.",
	timedOutNote:
		"Nothing was read, so this says nothing about what is on this machine — the sessions may all still be there.",
	retry: "Read the sessions again",
} as const;

/** Whole seconds, because a readout that ticks in milliseconds is a number nobody can read. */
const seconds = (millis: number): number => Math.floor(millis / 1000);

/**
 * How often the elapsed readout re-renders while a read is out. Finer than the second it prints, so
 * the wait ends near its deadline rather than up to a second after it.
 */
const TICK_MILLIS = 250;

/**
 * The clock the waiting readout is measured against: the caller's when it pinned one, otherwise
 * this window's own, ticking only while a read is actually out. A pinned clock never ticks, which
 * is what lets a test render one exact moment of the wait.
 */
const useClock = (pinned: number | undefined, status: SessionListStatus): number => {
	const [now, setNow] = useState(() => pinned ?? Date.now());
	const ticking = atClock(status, pinned ?? now)._tag === "Reading";
	useEffect(() => {
		if (pinned !== undefined || !ticking) return;
		const timer = setInterval(() => setNow(Date.now()), TICK_MILLIS);
		return () => clearInterval(timer);
	}, [pinned, ticking]);
	return pinned ?? now;
};

/**
 * How long the read has been out, said in time and nothing else. `role="progressbar"` rather than a
 * live region on purpose: a reader can query it whenever it wants, and a value that changes four
 * times a second announces nothing (Pillar 4 — the state *change* is announced, the ticks are not).
 */
const ReadingProgress = ({
	status,
	now,
}: {
	readonly status: ReadingSessions;
	readonly now: number;
}): ReactElement => {
	const elapsed = seconds(elapsedMillis(status, now));
	const deadline = seconds(status.deadlineMillis);
	const fraction = elapsedMillis(status, now) / status.deadlineMillis;
	return (
		<div className="tuval-session-list-reading" aria-busy="true">
			<div
				className="tuval-session-list-progress"
				role="progressbar"
				aria-label={COPY.elapsed}
				aria-valuemin={0}
				aria-valuemax={deadline}
				aria-valuenow={elapsed}
				aria-valuetext={`${elapsed} of ${deadline} seconds elapsed`}
				style={{"--tuval-elapsed": `${Math.round(fraction * 100)}%`} as Record<string, string>}
			>
				<div className="tuval-session-list-progress-fill" />
			</div>
			<p className="tuval-session-list-elapsed">{`${elapsed}s elapsed of a ${deadline}s deadline`}</p>
		</div>
	);
};

/**
 * The sentence a reader is told when the state changes, and nothing while a read is merely running:
 * it is derived from the tag alone, so the four ticks a second write the same string and the live
 * region stays silent until the state itself moves.
 */
const stateAnnouncement = (status: SessionListStatus): string | null => {
	if (status._tag === "Reading") return null;
	if (status._tag === "TimedOut") return COPY.timedOut;
	if (status._tag === "Refused") return COPY.refused;
	return status.sessions.length === 1
		? "1 session read."
		: `${status.sessions.length} sessions read.`;
};

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
	/** The read to render, waiting state included — there is no "no state yet" to infer one from. */
	readonly status: SessionListStatus;
	/** Ask for the read again. Offered on both terminal failures; absent, neither shows the button. */
	readonly onRetry?: () => void;
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
export function SessionList({status, onActivate, onRetry, now}: SessionListProps): ReactElement {
	const [chosen, setChosen] = useState<string | null>(null);
	const clock = useClock(now, status);
	const shown = atClock(status, clock);

	const sessions = shown._tag === "Listed" ? shown.sessions : [];
	const unreadable = shown._tag === "Listed" ? shown.unreadable : [];

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

	// Only reached once the read has settled: while it is out the palette is `loading` and shows
	// `loadingLabel` instead, with the elapsed readout beside it.
	const emptyLabel =
		shown._tag === "TimedOut"
			? COPY.timedOut
			: shown._tag === "Refused"
				? COPY.refused
				: sessions.length === 0
					? unreadable.length === 0
						? COPY.emptyStore
						: COPY.allRefused
					: COPY.noMatch;

	const error: ReactNode = shown._tag === "Refused" ? failureLine(shown.failure) : undefined;
	const failed = shown._tag === "TimedOut" || shown._tag === "Refused";

	return (
		<div className="tuval-session-list">
			<CommandPalette
				presentation="inline"
				items={items}
				title={TITLE}
				placeholder={COPY.placeholder}
				emptyLabel={emptyLabel}
				loading={shown._tag === "Reading"}
				loadingLabel={COPY.reading}
				filter={filter}
				onSelect={select}
				onKeyDown={keyDown}
				shortcut={false}
				announcement={chosen === null ? stateAnnouncement(shown) : `Chose ${chosen}.`}
				{...(error === undefined ? {} : {error})}
			/>
			{shown._tag === "Reading" ? <ReadingProgress status={shown} now={clock} /> : null}
			{shown._tag === "TimedOut" ? (
				<p className="tuval-session-list-note">{COPY.timedOutNote}</p>
			) : null}
			{failed && onRetry !== undefined ? (
				<div className="tuval-session-list-retry">
					<Button type="button" variant="tertiary" size="sm" onClick={onRetry}>
						{COPY.retry}
					</Button>
				</div>
			) : null}
			{unreadable.length === 0 ? null : <UnreadableBackends backends={unreadable} />}
		</div>
	);
}

/** What the page hands the window: where the read has got to, and how to ask for it again. */
export interface SessionListRead {
	readonly status: SessionListStatus;
	/** Absent when the page cannot re-issue the call — then no retry is offered rather than a dead one. */
	readonly retry?: () => void;
}

/**
 * How the renderer gets the read to render. The page owns it; the default asks nobody. It is a hook
 * the window calls on every render, so a source that reads state re-renders the window when the
 * reply lands. The window id rides along because a call names the window it came from.
 */
export type SessionListSource = (window: WindowId) => SessionListRead;

/**
 * The default: a read that was never sent. It still starts a clock, so a surface with no socket
 * behind it walks the same reading-then-timed-out path a real one does rather than claiming a
 * store it never asked about.
 */
const nothingRead: SessionListSource = () => {
	const [startedAt] = useState(() => Date.now());
	return {status: reading(startedAt)};
};

/** One session's transcript as the surface renders it, and the way to ask for the page before it. */
export interface TranscriptPaged {
	/** The history so far, waiting state included. `null` while the first read is out. */
	readonly answer: TranscriptAnswer | null;
	/** Absent when the caller cannot page — then the older affordance is not offered at all. */
	readonly onOlder?: () => void;
	readonly onRetry?: () => void;
}

/**
 * How the renderer gets one session's transcript. Like `SessionListSource` it is a hook the window
 * calls, so a source holding the landed pages re-renders the window when the next one arrives; it
 * is handed `openRead`'s own answer and the window the call comes from. It takes the request rather
 * than the read inside it because a row the store filed under no folder has no read to hand over,
 * and a hook cannot be skipped for it — so the refusal is a case the source is given rather than a
 * placeholder read invented to keep the call shape. The default reads none, so a surface with no
 * socket behind it says the read is out rather than claiming an empty session.
 */
export type TranscriptSource = (request: OpenRequest, window: WindowId) => TranscriptPaged;

const nothingPaged: TranscriptSource = () => ({answer: null});

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
	const read = (useAnswer ?? nothingRead)(window);
	const [view, setView] = useState<SessionListView>(listView);
	const [phase, setPhase] = useState<OpenPhase>("reading");
	const [sendRefusal, setSendRefusal] = useState<SendPlan["refused"]>(null);

	const activate = useCallback(
		(session: SessionRow, target: OpenTarget) => {
			onActivate?.(session, target);
			if (target === "new-window") {
				onOpenInNewWindow?.(session);
				return;
			}
			setPhase("reading");
			setSendRefusal(null);
			setView(sessionView(session));
		},
		[onActivate, onOpenInNewWindow],
	);

	const back = useCallback(() => {
		setPhase("reading");
		setSendRefusal(null);
		setView(listView);
	}, []);

	if (view.kind === "list") {
		return (
			<SessionList
				status={read.status}
				onActivate={activate}
				{...(read.retry === undefined ? {} : {onRetry: read.retry})}
			/>
		);
	}

	// The transcript is a child rather than an arm of this render, because the source is a hook:
	// called from here it would run on the session branch and not on the list branch, which is the
	// conditional-hook fault React refuses. The key is the session, so picking a second row unmounts
	// the first read's state instead of folding its pages into the new session's history.
	return (
		<SessionTranscriptHost
			key={`${view.session.programId}:${view.session.sessionId}`}
			session={view.session}
			window={window}
			useTranscript={useTranscript ?? nothingPaged}
			sendRefusal={sendRefusal}
			onBack={back}
			onSend={(text) => {
				// The phase is what makes the transition happen once: the first send hands back a spawn
				// and moves to `live`, and every send after it hands back none.
				const plan = send(phase, view.session);
				if (plan.refused !== null) {
					setSendRefusal(plan.refused);
					return false;
				}
				setPhase(plan.phase);
				onSend?.(view.session, text, plan);
				return true;
			}}
		/>
	);
}

/**
 * One session's transcript over whatever source the page bound. It exists so the source is called
 * unconditionally from a component whose whole life is this one session: the read it sends is
 * memoised on the row, so a re-render is not a second call, and unmounting is what discards a read
 * whose session is no longer on screen.
 */
function SessionTranscriptHost({
	sendRefusal,
	session,
	window,
	useTranscript,
	onBack,
	onSend,
}: {
	readonly session: SessionRow;
	readonly window: WindowId;
	readonly useTranscript: TranscriptSource;
	readonly onBack: () => void;
	readonly sendRefusal: SendPlan["refused"];
	readonly onSend: (text: string) => boolean;
}): ReactElement {
	// Memoised on the row, so the source's own effect sees one request for the life of this mount: a
	// fresh object every render would re-send the first page on every render.
	const request = useMemo(() => openRead(session), [session]);
	const paged = useTranscript(request, window);
	return (
		<SessionTranscriptView
			session={session}
			answer={paged.answer}
			unopenable={request._tag === "OpenRefused" || sendRefusal !== null}
			onBack={onBack}
			onSend={onSend}
			{...(paged.onOlder === undefined ? {} : {onOlder: paged.onOlder})}
			{...(paged.onRetry === undefined ? {} : {onRetry: paged.onRetry})}
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
