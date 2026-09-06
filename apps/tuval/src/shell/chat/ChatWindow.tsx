/**
 * `ChatWindow` — the one chat renderer both AI agent programs bind (founder ruling 2026-09-02,
 * amended on #7572 / #7584). It is a `WindowRenderer` (#7553) over the `ai-agent-session` state and
 * the five ports' vocabulary, and it knows nothing about Pi or Claude: everything it reads is the
 * model-blind item union of `../../ai-agent/ports/`, and everything it sends is a Msg of
 * `../../ai-agent/core/`. Both of those are `import type` only, so this module pulls no agent code
 * into the browser bundle at all.
 *
 * Four things here are not obvious from the code:
 *
 * **The composer is not wrapped, it is driven through its bridge.** `AgentChatInput`
 * (`@kampus/design`, #7561) has no `onSubmit` — it sends through an `AgentChatInputBridge` and
 * reads its working/ready state off that bridge's event stream. `./composer-bridge.ts` is that
 * seam, and it is why the shared composer needs no Tuval-shaped fork.
 *
 * **Paging anchors on an item, not on an offset.** A page prepends rows above the viewport, so the
 * offset that meant "here" before the prepend means somewhere older after it. The window remembers
 * the id of the oldest row it held, finds that row again in the new list and scrolls back onto it —
 * which is stable whether the head row stayed (more history behind) or disappeared (the beginning
 * of history).
 *
 * **Four writes move the transcript, and one pin decides between them.** A window resting on its
 * newest turn follows every turn that lands; one whose reader scrolled up is left alone, and so is
 * one anchored on a history page, on a row it just expanded or on a fold it just opened. That is
 * `view.pinned`: it is set from the scroll offset on every scroll, cleared by opening a row's own
 * disclosure, opening a group's fold or asking for a page of history, and set again by sending. Two
 * anchoring effects reach the viewport only while it is clear, and every door into them clears it
 * itself rather than trusting the geometry to have done so: a transcript barely taller than its
 * viewport is inside the top threshold and the bottom one at once.
 *
 * **Nothing is ever auto-resent.** An `interrupted` marker renders the cut turn and offers a
 * resend; the resend is a deliberate new send and mints a fresh idempotency key (ruling 2, #7570),
 * never a retry of the key the interrupted turn used. The same holds for a send that never landed:
 * the window keeps the text (`./outgoing.ts`) and offers it back, and putting it in the composer is
 * as far as recovery goes.
 */

import {AgentChatInput, Button, DesignTranslationProvider, Kbd, Markdown} from "@kampus/design";
import {useVirtualizer, type VirtualizerOptions} from "@tanstack/react-virtual";
import {Effect, Fiber, Stream} from "effect";
import type {ReactElement, KeyboardEvent as ReactKeyboardEvent, ReactNode, UIEvent} from "react";
import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import type {Mode, TranscriptItem} from "../../ai-agent/ports/index.ts";
import type {ProcessView, WindowHost, WindowRenderer} from "../window/index.ts";
import {windowRenderer} from "../window/index.ts";
import {CompactionMarker} from "./CompactionMarker.tsx";
import {composerBridge} from "./composer-bridge.ts";
import {tuvalDesignTranslate} from "./copy.ts";
import {ModeSwitch} from "./ModeSwitch.tsx";
import {dropSend, holdSend, readHeld, recoverInto} from "./outgoing.ts";
import {type PermissionAnswer, PermissionCards} from "./PermissionCards.tsx";
import {interruptionGraceMillis, isWorking, statusLine} from "./phase.ts";
import {QueuedMessages} from "./QueuedMessages.tsx";
import {
	type ChatRow,
	chatRows,
	mergeOlder,
	oldestLoadedId,
	type RowItem,
	rowIndexOfItem,
	rowKey,
} from "./rows.ts";
import {SessionRow} from "./SessionRow.tsx";
import {ThinkingRow} from "./ThinkingRow.tsx";
import {type ToolFold, ToolRow} from "./ToolRow.tsx";
import {UnsentMessages} from "./UnsentMessages.tsx";
import {asChatView, type ChatView} from "./view.ts";
import "./chat.css";

export type ChatWindowHost = WindowHost<AiAgentSessionState, AiAgentSessionMsg, ChatView>;
export type ChatWindowRenderer = WindowRenderer<
	ReactNode,
	AiAgentSessionState,
	AiAgentSessionMsg,
	ChatView
>;

export interface ChatWindowOptions {
	/**
	 * The program's own extras in the status bar, beside the phase line.
	 *
	 * This is the whole of what a thin renderer adds on top of the shared window (founder ruling
	 * 2026-09-02, amended on #7572 / #7584), and it is a function of the live state because that is
	 * what a renderer is: `f(state, view)`. **No program passes one today**: the founder's 2026-09-05
	 * ruling (#8190) sent both backends' usage and session lines to the desk inspector, so the bar
	 * carries the phase line alone. The slot itself stays — retiring it is a separate call — and a
	 * program with no extras renders exactly the bar both backends render now.
	 */
	readonly extras?: (state: AiAgentSessionState) => ReactNode;
	/** Mints one idempotency key per deliberate send (ruling 2, #7570). */
	readonly newKey?: () => string;
	/** The clock a send stamps its turn with, so no update cell has to read one (#7978). */
	readonly now?: () => number;
	readonly pageLimit?: number;
	readonly overscan?: number;
	/** First guess per row, before the row is rendered and measured. */
	readonly estimateRowHeight?: number;
	/** How close to the top counts as "at the top" for the next page, in pixels. */
	readonly topThreshold?: number;
	/** How much tail may hang below the fold and still count as "on the newest turn", in pixels. */
	readonly bottomThreshold?: number;
	/** How long the scroll offset settles before it is written to the view slot. */
	readonly scrollCommitMs?: number;
	/**
	 * How the transcript scrolls. The default is the virtualizer's own `element.scrollTo`; a test
	 * substitutes a recorder, because jsdom has no layout and so no scroll to observe.
	 */
	readonly scrollToFn?: VirtualizerOptions<HTMLDivElement, Element>["scrollToFn"];
}

interface ResolvedOptions {
	readonly extras: ((state: AiAgentSessionState) => ReactNode) | null;
	readonly newKey: () => string;
	readonly now: () => number;
	readonly pageLimit: number;
	readonly overscan: number;
	readonly estimateRowHeight: number;
	readonly topThreshold: number;
	readonly bottomThreshold: number;
	readonly scrollCommitMs: number;
	readonly scrollToFn?: VirtualizerOptions<HTMLDivElement, Element>["scrollToFn"];
}

const resolve = (options: ChatWindowOptions): ResolvedOptions => ({
	extras: options.extras ?? null,
	newKey: options.newKey ?? (() => crypto.randomUUID()),
	now: options.now ?? (() => Date.now()),
	pageLimit: options.pageLimit ?? 50,
	overscan: options.overscan ?? 6,
	estimateRowHeight: options.estimateRowHeight ?? 72,
	topThreshold: options.topThreshold ?? 64,
	bottomThreshold: options.bottomThreshold ?? 64,
	scrollCommitMs: options.scrollCommitMs ?? 150,
	...(options.scrollToFn === undefined ? {} : {scrollToFn: options.scrollToFn}),
});

/**
 * The process's public state, live. The stream never fails and ends on `ProcessGone`, so there is
 * no error arm: `null` is "nothing yet" and the gone arm is a value the surface renders.
 */
const useProcessView = (host: ChatWindowHost): ProcessView<AiAgentSessionState> | null => {
	const [view, setView] = useState<ProcessView<AiAgentSessionState> | null>(null);
	const read = host.readProcess;
	useEffect(() => {
		const fiber = Effect.runFork(
			Stream.runForEach(read, (next) => Effect.sync(() => setView(next))),
		);
		return () => void Effect.runFork(Fiber.interrupt(fiber));
	}, [read]);
	return view;
};

/**
 * A bare printable character typed on the transcript belongs to nobody: the scroll region has no
 * text to take it, and letting it reach the desk's one keyboard listener either arms the prefix or
 * forwards it into the window's process (#7973). Modified keys are somebody else's — the desk
 * prefix is Ctrl-keyed and Alt+R is the window's — and so is every named key the region scrolls on.
 */
const swallowBareCharacter = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
	const bare = !event.ctrlKey && !event.metaKey && !event.altKey && [...event.key].length === 1;
	if (bare) event.stopPropagation();
};

/**
 * Is the transcript resting on its newest turn? The list is virtualized, so the mounted rows are
 * the overscan window and their heights are not the transcript's height — the tail hanging below
 * the fold is the virtualizer's total size against the scroller's own viewport.
 */
const onNewest = (scroller: HTMLDivElement | null, totalSize: number, threshold: number): boolean =>
	scroller !== null && totalSize - (scroller.scrollTop + scroller.clientHeight) <= threshold;

const Placeholder = ({children}: {readonly children: ReactNode}): ReactElement => (
	<p className="tuval-chat-placeholder" role="status">
		{children}
	</p>
);

// No `system` key, and none is missing: a session notice is a `session` row, never an item row.
const who: Readonly<Record<RowItem["kind"], string>> = {
	user: "you",
	assistant: "agent",
	tool: "tool",
	thinking: "thinking",
	compaction: "compaction",
};

/**
 * What a row shows under its label. Three kinds carry a shape of their own: a tool call and a
 * thinking row are disclosures over this window's one `expanded` set, and a compaction row is a
 * divider rather than a line of prose. A session line never reaches here: `RowView` folds those
 * into the session row. Everything else, an agent reply and what the operator typed alike,
 * renders through the shared markdown block, which paints synchronously so the row's measurement
 * still holds (#8012/#8226): a fence the operator sends is the fence the agent received.
 */
function RowBody({
	item,
	expanded,
	fold,
	onToggleRow,
}: {
	readonly item: RowItem;
	readonly expanded: boolean;
	readonly fold: ToolFold | null;
	readonly onToggleRow: (id: string, open: boolean) => void;
}): ReactElement {
	if (item.kind === "tool") {
		return (
			<ToolRow
				item={item}
				expanded={expanded}
				fold={fold}
				onToggle={(open) => onToggleRow(item.id, open)}
			/>
		);
	}
	if (item.kind === "thinking") {
		return (
			<ThinkingRow
				item={item}
				expanded={expanded}
				onToggle={(open) => onToggleRow(item.id, open)}
			/>
		);
	}
	if (item.kind === "compaction") return <CompactionMarker text={item.text} />;
	// The transcript is a region inside the desk, so a `#` heading in a message is a subsection of
	// it rather than a page title; and a transcript row is read as the lines it was typed on, so a
	// lone newline is a break here where a document-shaped surface would fold it (#8244).
	return (
		<Markdown className="tuval-chat-markdown" headingBase={3} breaks>
			{item.text}
		</Markdown>
	);
}

function ItemRow({
	item,
	interrupted,
	onResend,
	expanded,
	fold,
	nested,
	onToggleRow,
}: {
	readonly item: RowItem;
	readonly interrupted: boolean;
	readonly onResend: (() => void) | null;
	readonly expanded: boolean;
	readonly fold: ToolFold | null;
	readonly nested: boolean;
	readonly onToggleRow: (id: string, open: boolean) => void;
}): ReactElement {
	return (
		<>
			{/* A nested row says whose call it was in words; the indent beside it is the second signal. */}
			<span className="tuval-chat-who">{nested ? "subagent" : who[item.kind]}</span>
			<RowBody item={item} expanded={expanded} fold={fold} onToggleRow={onToggleRow} />
			{interrupted ? (
				<span className="tuval-chat-interrupted">
					<span className="tuval-chat-interrupted-mark">interrupted</span>
					{onResend === null ? null : (
						<Button type="button" variant="tertiary" size="sm" onClick={onResend}>
							Resend <Kbd>Alt+R</Kbd>
						</Button>
					)}
				</span>
			) : null}
		</>
	);
}

/**
 * The DOM id of the row carrying one item, scoped to the window so two windows over one process
 * never mint the same id. A group head's fold points `aria-controls` at these.
 */
const rowDomId = (windowId: string, itemId: string): string => `tuval-row-${windowId}-${itemId}`;

function RowView({
	row,
	windowId,
	interruptedId,
	onResend,
	onOlder,
	expanded,
	unfolded,
	onToggleRow,
	onToggleFold,
}: {
	readonly row: ChatRow;
	readonly windowId: string;
	readonly interruptedId: string | null;
	readonly onResend: (() => void) | null;
	readonly onOlder: () => void;
	readonly expanded: ReadonlySet<string>;
	readonly unfolded: ReadonlySet<string>;
	readonly onToggleRow: (id: string, open: boolean) => void;
	readonly onToggleFold: (id: string, open: boolean) => void;
}): ReactElement {
	if (row.kind === "loading") {
		return (
			<span className="tuval-chat-head" role="status">
				Loading earlier messages…
			</span>
		);
	}
	if (row.kind === "older") {
		return (
			<span className="tuval-chat-head">
				<Button type="button" variant="tertiary" size="sm" onClick={onOlder}>
					Load earlier messages
				</Button>
				{row.items > 0 ? <span>{row.items} omitted here</span> : null}
			</span>
		);
	}
	if (row.kind === "session") {
		// The run's first notice is its identity, in the `expanded` set as in `rowKey`, so a notice
		// joining the run behind it does not close a disclosure the reader opened.
		const id = row.items[0].id;
		return (
			<>
				<span className="tuval-chat-who">session</span>
				<SessionRow
					run={row.items}
					expanded={expanded.has(id)}
					onToggle={(next) => onToggleRow(id, next)}
				/>
			</>
		);
	}
	const open = unfolded.has(row.item.id);
	return (
		<ItemRow
			item={row.item}
			interrupted={row.item.id === interruptedId}
			onResend={row.item.id === interruptedId ? onResend : null}
			expanded={expanded.has(row.item.id)}
			fold={
				row.nestedIds.length === 0
					? null
					: {
							rowIds: row.nestedIds.map((id) => rowDomId(windowId, id)),
							open,
							onToggle: (next) => onToggleFold(row.item.id, next),
						}
			}
			nested={row.nested}
			onToggleRow={onToggleRow}
		/>
	);
}

function ChatWindow({
	host,
	options,
}: {
	readonly host: ChatWindowHost;
	readonly options: ResolvedOptions;
}): ReactElement {
	const hostRef = useRef(host);
	hostRef.current = host;

	const process = useProcessView(host);
	const state = process?._tag === "Live" ? process.state : null;

	// The slot is read once and then owned here: it is this window's own scratch space, and a
	// re-read on every render would fight the writes below on a host whose `view()` lags a commit.
	const [view, setViewLocal] = useState<ChatView>(() => asChatView(host.view()));
	const [older, setOlder] = useState<ReadonlyArray<TranscriptItem>>([]);
	const [loading, setLoading] = useState(false);

	// The last committed view, so `commit` can apply `next` and fork the host write out here rather
	// than inside the `setViewLocal` updater. React documents an updater as pure and re-invokes it —
	// `StrictMode` does so on every commit, and Tuval only ever runs in development (ADR 0345) — so
	// a `runFork` in there is two `setView` calls per keystroke. The ref is written in the same tick
	// as the state, which is what keeps two commits batched into one render composing: the debounced
	// scroll offset and `toggleRow`'s expanded set both read what the previous commit wrote.
	const viewRef = useRef(view);

	const commit = useCallback((next: (current: ChatView) => ChatView) => {
		const current = viewRef.current;
		const value = next(current);
		// The identity has to stop the host write and not just the local one: `window.setView`
		// rebuilds `ShellState` wholesale (`../core/machine.ts`), so a no-change write from
		// `onScroll` re-renders every subscriber of the desk once per scroll frame — the cost
		// the `scrollCommitMs` debounce beside it exists to bound.
		if (value === current) return;
		viewRef.current = value;
		void Effect.runFork(hostRef.current.setView(value));
		setViewLocal(value);
	}, []);

	const dispatch = useCallback((msg: AiAgentSessionMsg) => {
		void Effect.runFork(hostRef.current.dispatch(msg));
	}, []);

	const expanded = useMemo(() => new Set(view.expanded), [view.expanded]);
	const unfolded = useMemo(() => new Set(view.unfolded), [view.unfolded]);

	/** The row just opened, until the layout effect below has scrolled its trigger back into view. */
	const openedRef = useRef<string | null>(null);

	const toggleRow = useCallback(
		(id: string, open: boolean) => {
			if (open) openedRef.current = id;
			commit((current) => {
				const held = current.expanded.includes(id);
				if (held === open) return current;
				return {
					...current,
					// The effect below anchors an opened row to the top, and a window still following
					// its newest turn would pull the viewport straight back off it.
					pinned: open ? false : current.pinned,
					expanded: open
						? [...current.expanded, id]
						: current.expanded.filter((other) => other !== id),
				};
			});
		},
		[commit],
	);

	const toggleFold = useCallback(
		(id: string, open: boolean) => {
			if (open) openedRef.current = id;
			commit((current) => {
				const held = current.unfolded.includes(id);
				if (held === open) return current;
				return {
					...current,
					// Same as an opened tool row: a revealed fold is anchored, and a following window
					// would pull the viewport straight back off it.
					pinned: open ? false : current.pinned,
					unfolded: open
						? [...current.unfolded, id]
						: current.unfolded.filter((other) => other !== id),
				};
			});
		},
		[commit],
	);

	const answerPermission = useCallback(
		(answer: PermissionAnswer) => dispatch({type: "answer", ...answer}),
		[dispatch],
	);

	const setMode = useCallback((mode: Mode) => dispatch({type: "setMode", mode}), [dispatch]);

	const rows = useMemo(
		() =>
			chatRows({
				older,
				tail: state?.transcript.items ?? [],
				omitted: state?.transcript.omitted.items ?? 0,
				loading,
				atOldest: view.atOldest,
				unfolded,
			}),
		[older, state, loading, view.atOldest, unfolded],
	);

	/** The row the viewport was resting on when the current page was asked for. */
	const anchorRef = useRef<string | null>(null);
	/** Set when a page lands, cleared by the layout effect that re-anchors the viewport onto it. */
	const reanchorRef = useRef(false);
	const seenPageRef = useRef<AiAgentSessionState["lastPage"]>(null);

	const scrollRef = useRef<HTMLDivElement | null>(null);
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => options.estimateRowHeight,
		getItemKey: (index) => rowKey(rows[index] ?? {kind: "loading"}),
		overscan: options.overscan,
		// `measureElement` runs as a React `ref` callback, so a row whose measured height differs
		// from the estimate notifies during the commit — and this binding's default turns a `sync`
		// notification into `flushSync(rerender)` (`@tanstack/react-virtual@3.14.10`,
		// `useVirtualizerBase`). React refuses that from inside a lifecycle method, and a real load
		// of this window printed sixteen of those errors. Off, the same update lands through React's
		// own scheduling on the next render.
		useFlushSync: false,
		...(options.scrollToFn === undefined ? {} : {scrollToFn: options.scrollToFn}),
	});

	const totalSize = virtualizer.getTotalSize();

	const requestOlder = useCallback(() => {
		if (loading || view.atOldest || rows.length === 0) return;
		const before = oldestLoadedId(rows);
		if (before === null) return;
		anchorRef.current = before;
		setLoading(true);
		// Asking for history is leaving the newest turn, and the pin has to say so or the re-anchor
		// below loses. On a transcript barely taller than its viewport every offset is within *both*
		// thresholds, so the top that fires this still reads as resting on the newest turn — and
		// when the page lands the follow effect, declared after the re-anchor, overrides it and
		// throws the reader to the bottom of the history they just asked for.
		commit((current) => (current.pinned ? {...current, pinned: false} : current));
		dispatch({type: "page", before, limit: options.pageLimit});
	}, [loading, view.atOldest, rows, commit, dispatch, options.pageLimit]);

	// `lastPage` is shared session state, so every mounted window sees a page any one of them asked
	// for (#7860). A window consumes one only while its own request is out: without the `loading`
	// guard a window that scrolled nowhere gets the other's history prepended and its `atOldest`
	// advanced, which is what made the per-window cursor a slot that never diverged. The seen-marker
	// is set either way, so a window that ignored a page does not merge it later when it does ask.
	//
	// The guard is a proxy, not a correlation, and #7860 stays open on the residual: `loading`
	// answers "is *my* request out", but `lastPage` carries no requester and `page` (`core/machine.ts`)
	// issues its Cmd with no in-flight guard — so two windows whose requests overlap each still merge
	// whichever reply lands first. Closing that needs the reply to name the window that asked, which
	// is a change to the Msg and the core rather than to this effect.
	useEffect(() => {
		const page = state?.lastPage ?? null;
		if (page === null || page === seenPageRef.current) return;
		seenPageRef.current = page;
		if (!loading) return;
		setOlder((held) => mergeOlder(held, page.items));
		setLoading(false);
		reanchorRef.current = true;
		commit((current) => ({
			...current,
			cursor: page.items[0]?.id ?? current.cursor,
			atOldest: !page.hasMore,
		}));
	}, [state?.lastPage, loading, commit]);

	useLayoutEffect(() => {
		if (!reanchorRef.current) return;
		reanchorRef.current = false;
		const index = rowIndexOfItem(rows, anchorRef.current);
		if (index >= 0) virtualizer.scrollToIndex(index, {align: "start"});
	}, [rows, virtualizer]);

	// An expanded row grows downward from its own top, so a row opened near the bottom pushes its
	// own trigger off the top edge — the operator clicks a disclosure and the thing they clicked
	// leaves the screen. Anchoring the opened row to the top puts the trigger back above its panel.
	useLayoutEffect(() => {
		const opened = openedRef.current;
		if (opened === null) return;
		openedRef.current = null;
		const index = rowIndexOfItem(rows, opened);
		if (index >= 0) virtualizer.scrollToIndex(index, {align: "start"});
		// `view.expanded` and `view.unfolded` are the dependencies that matter: opening an ordinary row
		// leaves `rows` untouched — the list is the same items — so an effect keyed on `rows` alone
		// would never run for it. A fold is the case where both change, and the lookup covers either.
	}, [view.expanded, view.unfolded, rows, virtualizer]);

	// First paint lands where a chat belongs: on the newest turn, or back on the offset this window
	// was left at. Once, and never again — a later re-render must not yank the operator's scroll.
	// A window left following its newest turn is restored onto the newest row and not onto its saved
	// offset: that offset was the bottom when it was written, and the transcript has grown since.
	const placedRef = useRef(false);
	useLayoutEffect(() => {
		if (placedRef.current || rows.length === 0) return;
		placedRef.current = true;
		if (!view.pinned && view.scroll > 0) virtualizer.scrollToOffset(view.scroll);
		else virtualizer.scrollToIndex(rows.length - 1, {align: "end"});
	}, [rows.length, view.pinned, view.scroll, virtualizer]);

	// …and after that, the transcript follows the newest turn only while it is already resting on
	// it. `totalSize` carries both cases the follow owes: a row appended, and the last row measuring
	// taller than the estimate — which lands a render late, because `useFlushSync: false` above
	// defers `measureElement`'s notification to React's own scheduling.
	useLayoutEffect(() => {
		if (!view.pinned || rows.length === 0) return;
		virtualizer.scrollToIndex(rows.length - 1, {align: "end"});
	}, [view.pinned, rows.length, totalSize, virtualizer]);

	const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (commitTimer.current !== null) clearTimeout(commitTimer.current);
		},
		[],
	);

	const onScroll = useCallback(
		(event: UIEvent<HTMLDivElement>) => {
			const offset = event.currentTarget.scrollTop;
			// The pin is written on the transition and not through the debounce below: a turn landing
			// inside the settle window would otherwise read a pin the operator has already left.
			const pinned = onNewest(event.currentTarget, totalSize, options.bottomThreshold);
			commit((current) => (current.pinned === pinned ? current : {...current, pinned}));
			if (commitTimer.current !== null) clearTimeout(commitTimer.current);
			commitTimer.current = setTimeout(() => {
				commitTimer.current = null;
				commit((current) => (current.scroll === offset ? current : {...current, scroll: offset}));
			}, options.scrollCommitMs);
			if (offset <= options.topThreshold) requestOlder();
		},
		[
			commit,
			options.bottomThreshold,
			options.scrollCommitMs,
			options.topThreshold,
			requestOlder,
			totalSize,
		],
	);

	const phase = state?.phase ?? "idle";
	const models = state?.models ?? null;
	const commands = state?.commands ?? null;
	const thinking = state?.thinking ?? null;
	const composer = useMemo(
		() =>
			composerBridge({
				initialPhase: phase,
				initialModels: models ?? {current: null, available: []},
				initialCommands: commands ?? [],
				initialThinking: thinking ?? {current: null, available: []},
				// The draft clears and the text is held under the send's own key in the same commit:
				// the composer empties as it always did, and nothing is thrown away until the session
				// says the layer took it (#8005).
				onPrompt: (text) => {
					const key = options.newKey();
					dispatch({type: "prompt", text, key, timestamp: options.now()});
					// Sending is the operator asking for the answer, so the window re-pins: one who
					// scrolled up to read history and then typed sees their own turn and the reply.
					commit((current) => ({
						...current,
						draft: "",
						pinned: true,
						outgoing: holdSend(current.outgoing, {key, text}),
					}));
				},
				onInterrupt: () => dispatch({type: "interrupt", at: options.now()}),
				onSetModel: (model) => dispatch({type: "setModel", model}),
				onSetThinkingLevel: (level) => dispatch({type: "setThinkingLevel", level}),
			}),
		// `phase`, `models`, `commands` and `thinking` seed the bridge and are deliberately not
		// dependencies:
		// `AgentChatInput` re-runs its whole load on a new bridge identity, so a bridge rebuilt per
		// change would drop the composer back into `loading` on every turn. All four reach it
		// through the setters below.
		[dispatch, commit, options.newKey, options.now],
	);
	useEffect(() => composer.setPhase(phase), [composer, phase]);
	useEffect(() => {
		if (models !== null) composer.setModels(models);
	}, [composer, models]);
	useEffect(() => {
		if (commands !== null) composer.setCommands(commands);
	}, [composer, commands]);
	useEffect(() => {
		if (thinking !== null) composer.setThinking(thinking);
	}, [composer, thinking]);

	// A held send leaves this window on the session's word rather than on this window's own read of
	// what it dispatched: `sends` answers per idempotency key, so a refusal the other window earned
	// settles the other window's copy and never this one's (#8005).
	const sends = state?.sends ?? null;
	const held = useMemo(() => readHeld(view.outgoing, sends ?? []), [view.outgoing, sends]);

	useEffect(() => {
		if (held.landed.length === 0) return;
		commit((current) => ({
			...current,
			outgoing: current.outgoing.filter((send) => !held.landed.includes(send.key)),
		}));
	}, [held.landed, commit]);

	const restoreSend = useCallback(
		(key: string) =>
			commit((current) => {
				const saved = current.outgoing.find((send) => send.key === key);
				if (saved === undefined) return current;
				return {
					...current,
					draft: recoverInto(current.draft, saved.text),
					outgoing: dropSend(current.outgoing, key),
				};
			}),
		[commit],
	);

	const discardSend = useCallback(
		(key: string) => commit((current) => ({...current, outgoing: dropSend(current.outgoing, key)})),
		[commit],
	);

	const interruptedId = state?.interrupted ?? null;
	const interruption = state?.interruption ?? null;
	// The status line is time-dependent only while an abort is unanswered, and it changes exactly
	// once — when the grace runs out. So one timeout at that boundary re-renders it, rather than a
	// poll ticking for the whole turn.
	const [, passGrace] = useState(0);
	useEffect(() => {
		if (interruption === null) return;
		const remaining = interruption.requestedAt + interruptionGraceMillis - options.now();
		if (remaining <= 0) return;
		const timer = setTimeout(() => passGrace((count) => count + 1), remaining);
		return () => clearTimeout(timer);
	}, [interruption, options.now]);

	const lastPrompt = state?.lastPrompt ?? null;
	const resend = useCallback(() => {
		if (lastPrompt === null) return;
		dispatch({type: "prompt", text: lastPrompt, key: options.newKey(), timestamp: options.now()});
	}, [dispatch, lastPrompt, options.newKey, options.now]);

	const onKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLDivElement>) => {
			if (event.defaultPrevented) return;
			if (event.key === "Escape" && isWorking(phase)) {
				event.preventDefault();
				dispatch({type: "interrupt", at: options.now()});
				return;
			}
			if (event.altKey && (event.key === "r" || event.key === "R") && interruptedId !== null) {
				event.preventDefault();
				resend();
			}
		},
		[dispatch, interruptedId, options.now, phase, resend],
	);

	if (process === null) {
		return (
			<div className="tuval-chat" data-scheme="dark" data-window={host.windowId}>
				<Placeholder>This window has nothing to show yet.</Placeholder>
			</div>
		);
	}
	if (process._tag === "ProcessGone") {
		return (
			<div className="tuval-chat" data-scheme="dark" data-window={host.windowId}>
				<Placeholder>
					Process {process.processId} is gone. The window is still yours — open something else in
					it.
				</Placeholder>
			</div>
		);
	}

	return (
		// The two window-wide keys (Escape while a turn runs, Alt+R to resend) belong to the window
		// rather than to any one control inside it, so the container listens on the bubble while the
		// composer's textarea keeps focus. A named `section` is what that owes a screen reader: the
		// phase line, the transcript and the composer are one named region, and every control inside
		// it is a real `button` or `textarea` with its own keyboard behaviour.
		// The provider sits above the whole window, not just the composer: a design primitive the
		// transcript mounts (a table's scroller name) reads this catalog too, and the package's own
		// default is Turkish.
		<DesignTranslationProvider translate={tuvalDesignTranslate}>
			<section
				className="tuval-chat"
				aria-label="Agent chat"
				data-scheme="dark"
				data-window={host.windowId}
				onKeyDown={onKeyDown}
			>
				<div className="tuval-chat-bar">
					<p className="tuval-chat-phase" data-phase={phase} role="status">
						<span className="tuval-chat-phase-dot" aria-hidden="true" />
						{statusLine({
							phase,
							failure: state?.failure ?? null,
							interruption,
							now: options.now(),
						})}
					</p>
					<div className="tuval-chat-bar-end">
						{options.extras === null ? null : options.extras(process.state)}
					</div>
				</div>
				<div
					ref={scrollRef}
					className="tuval-chat-transcript"
					onScroll={onScroll}
					onKeyDown={swallowBareCharacter}
					role="log"
					aria-label="Transcript"
					// The scroll container is the only way to older turns on a plain transcript, so a
					// keyboard user must be able to focus it (axe scrollable-region-focusable).
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region must take keyboard focus
					tabIndex={0}
				>
					<div className="tuval-chat-spacer" style={{height: `${totalSize}px`}}>
						{virtualizer.getVirtualItems().map((virtual) => {
							const row = rows[virtual.index];
							if (row === undefined) return null;
							return (
								<div
									key={virtual.key}
									id={
										row.kind === "item"
											? rowDomId(host.windowId, row.item.id)
											: row.kind === "session"
												? rowDomId(host.windowId, row.items[0].id)
												: undefined
									}
									className="tuval-chat-row"
									data-index={virtual.index}
									data-kind={row.kind === "item" ? row.item.kind : row.kind}
									data-nested={row.kind === "item" && row.nested ? "true" : undefined}
									ref={virtualizer.measureElement}
									style={{
										transform: `translateY(${virtual.start}px)`,
										// One indent step per fold the row sits inside, so a subagent's own subagent
										// reads as a further step in rather than as another row at the same level.
										...(row.kind === "item" && row.depth > 0 ? {"--nest-depth": row.depth} : {}),
									}}
								>
									<RowView
										row={row}
										windowId={host.windowId}
										interruptedId={interruptedId}
										onResend={lastPrompt === null ? null : resend}
										onOlder={requestOlder}
										expanded={expanded}
										unfolded={unfolded}
										onToggleRow={toggleRow}
										onToggleFold={toggleFold}
									/>
								</div>
							);
						})}
					</div>
				</div>
				{isWorking(phase) ? (
					// Visual only. The phase line above is the announced surface for the running turn, so a
					// live region here would narrate that same turn twice; what this adds is the tell at
					// the end of the transcript, where the eye already is while a turn runs.
					<p className="tuval-chat-working" aria-hidden="true">
						<span className="tuval-chat-working-dots">
							<span />
							<span />
							<span />
						</span>
						{interruption === null ? "Working…" : "Interrupting…"}
					</p>
				) : null}
				<PermissionCards permissions={process.state.permissions} onAnswer={answerPermission} />
				<QueuedMessages queued={process.state.queued} />
				<UnsentMessages
					windowId={host.windowId}
					unsent={held.unsent}
					onRestore={restoreSend}
					onDiscard={discardSend}
				/>
				<AgentChatInput
					variant="focused"
					bridge={composer.bridge}
					// The mode picker rides the composer's `settings` slot rather than the bridge: mode is
					// this window's vocabulary, and a bridge method would make every other implementor of
					// `AgentChatInputBridge` answer a question only this one has (#8190).
					settings={<ModeSwitch modes={process.state.modes} onSetMode={setMode} />}
					initialValue={view.draft}
					onDraftChange={(draft) =>
						commit((current) => (current.draft === draft ? current : {...current, draft}))
					}
				/>
			</section>
		</DesignTranslationProvider>
	);
}

/**
 * The renderer a program row's `RendererRef` resolves to. `windowRenderer` fixes the host shape off
 * the annotated parameter, so a renderer table that hands this one another program's host is a
 * compile error at the table (`../window/renderer.ts`).
 */
export const chatWindow = (options: ChatWindowOptions = {}): ChatWindowRenderer => {
	const resolved = resolve(options);
	return windowRenderer("host-native", (host: ChatWindowHost) => (
		<ChatWindow host={host} options={resolved} />
	));
};
